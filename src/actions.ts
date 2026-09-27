/**
 * Solana Actions ("Blinks").
 *
 * An Action is a pair of public endpoints: GET describes what can be done
 * (title, icon, buttons, form fields), POST takes the visitor's wallet address
 * and returns an unsigned transaction for them to sign. Wallets and blink
 * clients (Phantom, Backpack, Dialect, dial.to) render these as interactive
 * cards, including inside posts on X, so people can tip or pay without leaving
 * their feed and without an XLedger account.
 *
 * Same non-custodial model as the rest of the app: the server only builds the
 * transaction; the payer's own wallet signs and sends it. Recipient addresses
 * come from the database, never from the request.
 *
 * Spec: https://solana.com/docs/advanced/actions
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { PublicKey } from '@solana/web3.js';
import { config, db } from './config.js';
import { TOKENS, tokenBySymbol, toBaseUnits, fromBaseUnits, explorerTxUrl, type TokenInfo } from './tokens.js';
import { buildUnsigned, connection, isValidAddress, splTransferIxs, transferIx, verifyCredit } from './solana.js';
import { limiter } from './security.js';

export const actionsRouter = express.Router();

const ACTION_VERSION = '2.4';
const CHAIN_IDS: Record<string, string> = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOL_PRESETS = ['0.01', '0.05', '0.1'];

/**
 * Blink clients call these endpoints from other origins (x.com, dial.to,
 * wallet extensions), so they need open CORS. They carry no cookies and no
 * session, so allowing any origin is safe here. Everything else keeps the
 * strict same-origin policy.
 */
export function actionsCors(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api/actions') && req.path !== '/actions.json') return next();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Action-Version, X-Blockchain-Ids');
  res.setHeader('X-Action-Version', ACTION_VERSION);
  res.setHeader('X-Blockchain-Ids', CHAIN_IDS[config.solana.cluster] ?? CHAIN_IDS['mainnet-beta']);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

const actionError = (res: Response, code: number, message: string) => res.status(code).json({ message });

/** Square profile picture for the card; the site logo when there isn't one. */
function iconFor(avatarUrl: string | null): string {
  if (avatarUrl && /^https:\/\/(pbs|abs)\.twimg\.com\//.test(avatarUrl)) {
    return avatarUrl.replace('_normal.', '_400x400.');
  }
  return `${config.baseUrl}/logo.png`;
}

const solanaTokens = (): TokenInfo[] => TOKENS.filter((t) => t.chain === 'solana');

async function recipientByHandle(handle: string) {
  const h = handle.replace(/^@/, '');
  if (!/^\w{1,15}$/.test(h)) return null;
  const { rows } = await db.query<{ id: string; x_handle: string; wallet: string | null; avatar_url: string | null }>(
    `SELECT id, x_handle, wallet, avatar_url FROM users
      WHERE lower(x_handle) = lower($1)
      ORDER BY (wallet IS NOT NULL) DESC, wallet_verified_at DESC NULLS LAST
      LIMIT 1`,
    [h],
  );
  return rows[0] ?? null;
}

/** Instructions for a direct transfer, built exactly like the approval flow does. */
async function buildTransfer(payer: PublicKey, recipientWallet: string, token: TokenInfo, amount: bigint) {
  const to = new PublicKey(recipientWallet);
  const ixs = token.mint
    ? (await splTransferIxs({ from: payer, to, mint: token.mint, amount, decimals: token.decimals })).ixs
    : [transferIx(payer, to, amount)];
  return (await buildUnsigned(payer, ixs)).base64;
}

async function recordPending(opts: {
  recipientUserId: string;
  payer: string;
  token: TokenInfo;
  amount: bigint;
  requestId?: string | null;
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO blink_payments (recipient_user_id, payer_wallet, token_symbol, amount, request_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [opts.recipientUserId, opts.payer, opts.token.symbol, opts.amount.toString(), opts.requestId ?? null],
  );
  return rows[0].id;
}

// ------------------------------------------------------------ discovery

/**
 * Lets blink clients turn ordinary site links into Actions: sharing
 * usexledger.xyz/tip/alice unfurls the tip card for alice.
 */
actionsRouter.get('/actions.json', (_req, res) => {
  res.json({
    rules: [
      { pathPattern: '/tip/*', apiPath: '/api/actions/tip/*' },
      { pathPattern: '/pay/*', apiPath: '/api/actions/pay/*' },
      { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' },
    ],
  });
});

/** Public, no secrets: which RPC and cluster the browser should use when signed out. */
actionsRouter.get('/api/config', (_req, res) => {
  res.json({ rpcUrl: config.solana.publicRpcUrl, cluster: config.solana.cluster });
});

// ------------------------------------------------------------- tip jar

actionsRouter.get('/api/actions/tip/:handle', limiter('action-get', 240, 600), async (req, res) => {
  const r = await recipientByHandle(req.params.handle);
  if (!r) return actionError(res, 404, 'No XLedger account with that handle.');
  const base = `/api/actions/tip/${r.x_handle}`;
  const disabled = !r.wallet;
  res.json({
    type: 'action',
    icon: iconFor(r.avatar_url),
    title: `Tip @${r.x_handle}`,
    description: disabled
      ? `@${r.x_handle} hasn't linked a wallet yet.`
      : `Send @${r.x_handle} crypto straight from your wallet. XLedger never holds the funds.`,
    label: 'Tip',
    disabled,
    links: {
      actions: [
        ...SOL_PRESETS.map((a) => ({
          type: 'transaction',
          label: `${a} SOL`,
          href: `${base}?amount=${a}&token=SOL`,
        })),
        {
          type: 'transaction',
          label: 'Send tip',
          href: `${base}?amount={amount}&token={token}`,
          parameters: [
            { type: 'number', name: 'amount', label: 'Amount', required: true, min: 0 },
            {
              type: 'select',
              name: 'token',
              label: 'Token',
              required: true,
              options: solanaTokens().map((t, i) => ({ label: t.symbol, value: t.symbol, selected: i === 0 })),
            },
          ],
        },
      ],
    },
  });
});

actionsRouter.post('/api/actions/tip/:handle', limiter('action-post', 60, 600), async (req, res) => {
  const account = req.body?.account;
  if (!isValidAddress(account)) return actionError(res, 400, 'Connect a Solana wallet first.');
  const r = await recipientByHandle(req.params.handle);
  if (!r?.wallet) return actionError(res, 404, 'That account has no wallet linked.');
  if (r.wallet === account) return actionError(res, 400, "You can't tip your own wallet.");

  const token = tokenBySymbol(String(req.query.token ?? 'SOL'));
  if (!token || token.chain !== 'solana') return actionError(res, 400, 'Unsupported token.');
  let amount: bigint;
  try {
    amount = toBaseUnits(String(req.query.amount ?? '').trim(), token);
  } catch (err) {
    return actionError(res, 400, err instanceof Error ? err.message : 'Invalid amount.');
  }
  if (amount <= 0n) return actionError(res, 400, 'Amount must be greater than zero.');

  try {
    const payer = new PublicKey(account);
    const transaction = await buildTransfer(payer, r.wallet, token, amount);
    const id = await recordPending({ recipientUserId: r.id, payer: account, token, amount });
    res.json({
      type: 'transaction',
      transaction,
      message: `Tip ${fromBaseUnits(amount, token)} ${token.symbol} to @${r.x_handle}`,
      links: { next: { type: 'post', href: `/api/actions/confirm/${id}` } },
    });
  } catch (err) {
    console.error('action tip build failed:', err);
    actionError(res, 500, 'Could not build the transaction. Try again.');
  }
});

// -------------------------------------------------------- payment links

async function loadRequest(id: string) {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await db.query<{
    id: string;
    token_symbol: string;
    amount: string;
    note: string | null;
    status: string;
    requester_id: string;
    x_handle: string | null;
    wallet: string | null;
    avatar_url: string | null;
  }>(
    `SELECT r.id, r.token_symbol, r.amount, r.note, r.status,
            u.id AS requester_id, u.x_handle, u.wallet, u.avatar_url
       FROM payment_requests r JOIN users u ON u.id = r.requester_user_id
      WHERE r.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

actionsRouter.get('/api/actions/pay/:id', limiter('action-get', 240, 600), async (req, res) => {
  const r = await loadRequest(req.params.id);
  if (!r) return actionError(res, 404, 'Payment request not found.');
  const token = tokenBySymbol(r.token_symbol);
  const amount = token ? fromBaseUnits(BigInt(r.amount), token) : r.amount;
  const closed = r.status !== 'open' || !r.wallet;
  res.json({
    type: 'action',
    icon: iconFor(r.avatar_url),
    title: `@${r.x_handle} requested ${amount} ${r.token_symbol}`,
    description:
      r.status === 'paid'
        ? 'This request has been paid.'
        : r.status === 'cancelled'
          ? 'This request was cancelled.'
          : `${r.note ? `“${r.note}”. ` : ''}Pay from your own wallet. XLedger never holds the funds.`,
    label: r.status === 'paid' ? 'Paid' : `Pay ${amount} ${r.token_symbol}`,
    disabled: closed,
  });
});

actionsRouter.post('/api/actions/pay/:id', limiter('action-post', 60, 600), async (req, res) => {
  const account = req.body?.account;
  if (!isValidAddress(account)) return actionError(res, 400, 'Connect a Solana wallet first.');
  const r = await loadRequest(req.params.id);
  if (!r) return actionError(res, 404, 'Payment request not found.');
  if (r.status !== 'open') return actionError(res, 409, `This request is already ${r.status}.`);
  if (!r.wallet) return actionError(res, 409, `@${r.x_handle} has no wallet linked right now.`);
  if (r.wallet === account) return actionError(res, 400, "This is your own request.");
  const token = tokenBySymbol(r.token_symbol);
  if (!token || token.chain !== 'solana') return actionError(res, 409, 'Unsupported token.');

  try {
    const amount = BigInt(r.amount);
    const transaction = await buildTransfer(new PublicKey(account), r.wallet, token, amount);
    const id = await recordPending({ recipientUserId: r.requester_id, payer: account, token, amount, requestId: r.id });
    res.json({
      type: 'transaction',
      transaction,
      message: `Pay ${fromBaseUnits(amount, token)} ${token.symbol} to @${r.x_handle}`,
      links: { next: { type: 'post', href: `/api/actions/confirm/${id}` } },
    });
  } catch (err) {
    console.error('action pay build failed:', err);
    actionError(res, 500, 'Could not build the transaction. Try again.');
  }
});

// --------------------------------------------------------- confirmation

/**
 * Called by the blink client (links.next) or our own page once the payer's
 * transaction has been sent. Verified against the chain before anything is
 * recorded: the payer must be the transaction's fee payer, the recipient must
 * have been credited, and a signature can only ever count once.
 */
actionsRouter.post('/api/actions/confirm/:id', limiter('action-confirm', 60, 600), async (req, res) => {
  const { signature } = req.body ?? {};
  if (!UUID_RE.test(req.params.id)) return actionError(res, 404, 'Unknown payment.');
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature)) {
    return actionError(res, 400, 'Missing transaction signature.');
  }
  const { rows } = await db.query<{
    id: string;
    payer_wallet: string;
    token_symbol: string;
    amount: string;
    status: string;
    request_id: string | null;
    x_handle: string | null;
    wallet: string | null;
    avatar_url: string | null;
  }>(
    `SELECT b.id, b.payer_wallet, b.token_symbol, b.amount, b.status, b.request_id,
            u.x_handle, u.wallet, u.avatar_url
       FROM blink_payments b JOIN users u ON u.id = b.recipient_user_id
      WHERE b.id = $1`,
    [req.params.id],
  );
  const p = rows[0];
  if (!p || !p.wallet) return actionError(res, 404, 'Unknown payment.');
  const token = tokenBySymbol(p.token_symbol);
  if (!token) return actionError(res, 409, 'Unsupported token.');
  const shown = `${fromBaseUnits(BigInt(p.amount), token)} ${token.symbol}`;
  const done = {
    type: 'completed',
    icon: iconFor(p.avatar_url),
    title: 'Sent!',
    description: `${shown} is on its way to @${p.x_handle}.`,
    label: 'Done',
  };
  if (p.status === 'confirmed') return res.json(done);

  // The client may call this the moment it sends; give the chain a moment.
  let ok = false;
  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const feePayer = tx.transaction.message.getAccountKeys().staticAccountKeys[0];
      if (!feePayer?.equals(new PublicKey(p.payer_wallet))) {
        return actionError(res, 400, 'That transaction was not sent by this wallet.');
      }
      ok = await verifyCredit({
        signature,
        amount: BigInt(p.amount),
        ...(token.mint
          ? { mint: token.mint, ownerWallet: new PublicKey(p.wallet), transferFeeBps: token.transferFeeBps }
          : { destination: new PublicKey(p.wallet) }),
      });
      if (!ok) return actionError(res, 400, 'That transaction did not pay this recipient.');
    } catch (err) {
      console.error('action confirm check failed:', err);
    }
  }
  if (!ok) return actionError(res, 409, 'Not confirmed yet. It may still land; check your wallet.');

  let counted = false;
  try {
    const updated = await db.query(
      `UPDATE blink_payments SET status = 'confirmed', tx_signature = $2, confirmed_at = now()
        WHERE id = $1 AND status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM blink_payments WHERE tx_signature = $2)`,
      [p.id, signature],
    );
    counted = Boolean(updated.rowCount);
  } catch {
    counted = false; // unique signature: a concurrent call already counted it
  }
  if (!counted) return actionError(res, 409, 'That transaction was already counted.');

  if (p.request_id) {
    await db.query(
      `UPDATE payment_requests
          SET status = 'paid', paid_at = now(), tx_signature = $2, paid_by_wallet = $3,
              paid_by_user_id = (SELECT id FROM users WHERE wallet = $3 LIMIT 1)
        WHERE id = $1 AND status = 'open'`,
      [p.request_id, signature, p.payer_wallet],
    );
  }
  res.json({ ...done, description: `${done.description} ${explorerTxUrl('solana', signature, config.solana.cluster)}` });
});

// ------------------------------------------------------------- schema

export async function ensureActionsSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS blink_payments (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient_user_id BIGINT NOT NULL REFERENCES users(id),
      payer_wallet      TEXT NOT NULL,
      token_symbol      TEXT NOT NULL,
      amount            NUMERIC(78,0) NOT NULL CHECK (amount > 0),
      request_id        UUID,
      status            TEXT NOT NULL DEFAULT 'pending',
      tx_signature      TEXT UNIQUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmed_at      TIMESTAMPTZ
    )`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS blink_recipient_idx ON blink_payments(recipient_user_id, confirmed_at DESC)`,
  );
  await db.query(`ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS paid_by_wallet TEXT`);
}

/** Unsigned proposals that were never sent are just noise after a day. */
setInterval(() => {
  void db
    .query(`DELETE FROM blink_payments WHERE status = 'pending' AND created_at < now() - interval '1 day'`)
    .catch(() => {});
}, 60 * 60 * 1000).unref();
