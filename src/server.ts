import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config, db, lamportsToSol, attestorKeypair } from './config.js';
import { TOKENS, tokenBySymbol, fromBaseUnits, toBaseUnits, explorerTxUrl } from './tokens.js';
import { validateTipAmount } from './commands.js';

/** Format a stored base-unit amount by its token symbol (defaults to SOL). */
function fmtAmount(amount: string, symbol: string | null): string {
  const t = symbol ? tokenBySymbol(symbol) : null;
  return t ? fromBaseUnits(BigInt(amount), t) : lamportsToSol(BigInt(amount));
}

function logoFor(symbol: string | null): string | null {
  const t = symbol ? tokenBySymbol(symbol) : null;
  return t?.logoURI ?? null;
}
import { beginOAuth, exchangeCode, me, lookupUsersByIds } from './x.js';
import {
  buildUnsigned,
  claimIx,
  connection,
  isValidAddress,
  recipientXHash,
} from './solana.js';
import {
  buildIntentTransaction,
  preflightIntent,
  createIntent,
  confirmIntent,
  getIntentForSender,
  IntentError,
} from './intents.js';
import {
  cors,
  createSession,
  destroySession,
  limiter,
  requireAuth,
  requireCsrf,
  securityHeaders,
  type AuthedRequest,
} from './security.js';

const app = express();
app.set('trust proxy', 1);
app.use(securityHeaders);
app.use(cors);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

const fail = (res: Response, code: number, error: string) => res.status(code).json({ error });

// ---------------------------------------------------------------- X sign-in

/** Only same-site relative paths, so `next` can never become an open redirect. */
function safeNext(value: unknown): string {
  if (typeof value !== 'string') return '/dashboard';
  if (!value.startsWith('/') || value.startsWith('//')) return '/dashboard';
  return value.slice(0, 200);
}

app.get('/auth/login', limiter('login', 20, 600), async (req, res) => {
  if (!config.x.configured) return fail(res, 503, 'X sign-in is not configured on this server');
  const { url, state, codeVerifier } = beginOAuth();
  await db.query(`INSERT INTO oauth_states (state, code_verifier, next) VALUES ($1, $2, $3)`, [
    state,
    codeVerifier,
    safeNext(req.query.next),
  ]);
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) return fail(res, 400, 'Missing code or state');

  // Single-use state, bounded lifetime.
  const { rows } = await db.query<{ code_verifier: string; next: string | null }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND created_at > now() - interval '15 minutes'
      RETURNING code_verifier, next`,
    [state],
  );
  if (rows.length === 0) return fail(res, 400, 'That login link expired. Start again.');

  try {
    const token = await exchangeCode(code, rows[0].code_verifier);
    const profile = await me(token);
    const { rows: users } = await db.query<{ id: string }>(
      `INSERT INTO users (x_user_id, x_handle, avatar_url) VALUES ($1, $2, $3)
       ON CONFLICT (x_user_id) DO UPDATE
         SET x_handle = EXCLUDED.x_handle,
             avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url)
       RETURNING id`,
      [profile.id, profile.username, profile.profile_image_url ?? null],
    );
    await createSession(res, users[0].id, req.headers['user-agent']);
    res.redirect(config.webOrigin + safeNext(rows[0].next));
  } catch (err) {
    console.error('oauth callback failed:', err);
    fail(res, 502, 'X sign-in failed. Try again.');
  }
});

/**
 * Local development only. X OAuth needs a real developer app, which makes the
 * whole flow untestable on a laptop without one.
 *
 * Two independent gates, both required: NODE_ENV must not be production, and
 * ALLOW_DEV_LOGIN must be explicitly set. If either fails this route does not
 * exist. It is also refused outright when the process looks production-shaped
 * (a public BASE_URL), so a misconfigured deploy cannot expose it.
 */
if (!config.isProd && process.env.ALLOW_DEV_LOGIN === 'true') {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl)) {
    throw new Error(
      `ALLOW_DEV_LOGIN is set but BASE_URL (${config.baseUrl}) is not local. Refusing to start.`,
    );
  }
  console.warn('⚠  DEV LOGIN ENABLED — /auth/dev-login issues sessions with no password');

  app.get('/auth/dev-login', async (req, res) => {
    const handle = String(req.query.handle ?? 'devuser').replace(/^@/, '');
    if (!/^\w{1,15}$/.test(handle)) return fail(res, 400, 'Invalid handle');
    // Deterministic fake X id, so repeated logins land on the same account.
    const xUserId = `dev-${handle}`;
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (x_user_id, x_handle) VALUES ($1, $2)
       ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle
       RETURNING id`,
      [xUserId, handle],
    );
    await createSession(res, rows[0].id, req.headers['user-agent']);
    res.redirect(config.webOrigin + '/dashboard');
  });
}

app.post('/auth/logout', requireAuth, requireCsrf, async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ account

app.get('/api/me', requireAuth, async (req: AuthedRequest, res) => {
  const u = req.user!;
  const evmRow = await db.query<{ evm_wallet: string | null }>(
    `SELECT evm_wallet FROM users WHERE id = $1`,
    [u.id],
  );
  const [intents, waiting, sent, received] = await Promise.all([
    db.query(
      `SELECT id, recipient_x_handle, lamports, token_symbol, route, expires_at
         FROM tip_intents
        WHERE sender_user_id = $1 AND status = 'awaiting_approval' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 20`,
      [u.id],
    ),
    db.query(
      `SELECT pda, sender_x_handle, lamports, expires_at
         FROM escrows
        WHERE recipient_x_user_id = $1 AND status = 'funded'
        ORDER BY created_at DESC LIMIT 50`,
      [u.x_user_id],
    ),
    db.query(
      `SELECT recipient_x_handle, lamports, token_symbol, chain, route, status, tx_signature, created_at
         FROM tip_intents
        WHERE sender_user_id = $1 AND status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT 20`,
      [u.id],
    ),
    db.query(
      `SELECT s.x_handle AS from_handle, s.avatar_url, t.lamports, t.token_symbol, t.chain,
              t.tx_signature, t.confirmed_at
         FROM tip_intents t JOIN users s ON s.id = t.sender_user_id
        WHERE t.recipient_x_user_id = $1 AND t.status = 'confirmed'
        ORDER BY t.confirmed_at DESC LIMIT 20`,
      [u.x_user_id],
    ),
  ]);

  res.json({
    handle: u.x_handle,
    wallet: u.wallet,
    evmWallet: evmRow.rows[0]?.evm_wallet ?? null,
    csrfToken: req.csrfSecret,
    cluster: config.solana.cluster,
    rpcUrl: config.solana.publicRpcUrl,
    botHandle: config.x.botHandle,
    escrowEnabled: config.solana.escrowEnabled,
    xSignInAvailable: config.x.configured,
    pendingApprovals: intents.rows.map((r) => ({
      id: r.id,
      to: r.recipient_x_handle,
      amount: fmtAmount(r.lamports, r.token_symbol),
      token: r.token_symbol ?? 'SOL',
      logo: logoFor(r.token_symbol),
      route: r.route,
      expiresAt: r.expires_at,
    })),
    claimable: waiting.rows.map((r) => ({
      escrow: r.pda,
      from: r.sender_x_handle,
      amount: fmtAmount(r.lamports, 'SOL'),
      token: 'SOL',
      refundableAfter: r.expires_at,
    })),
    sent: sent.rows.map((r) => ({
      to: r.recipient_x_handle,
      amount: fmtAmount(r.lamports, r.token_symbol),
      token: r.token_symbol ?? 'SOL',
      logo: logoFor(r.token_symbol),
      route: r.route,
      signature: r.tx_signature,
      url: r.tx_signature ? explorerTxUrl(r.chain ?? 'solana', r.tx_signature, config.solana.cluster) : null,
      at: r.created_at,
    })),
    received: received.rows.map((r) => ({
      from: r.from_handle,
      avatar: avatarFor(r.avatar_url),
      amount: fmtAmount(r.lamports, r.token_symbol),
      token: r.token_symbol ?? 'SOL',
      logo: logoFor(r.token_symbol),
      signature: r.tx_signature,
      url: r.tx_signature ? explorerTxUrl(r.chain ?? 'solana', r.tx_signature, config.solana.cluster) : null,
      at: r.confirmed_at,
    })),
  });
});

// ------------------------------------------------------- wallet ownership

app.post('/api/wallet/challenge', requireAuth, requireCsrf, limiter('challenge', 10, 600), async (req: AuthedRequest, res) => {
  const nonce = randomBytes(24).toString('base64url');
  await db.query(`INSERT INTO wallet_nonces (nonce, user_id) VALUES ($1, $2)`, [nonce, req.user!.id]);
  // The message is bound to this domain, this X account and this nonce, so a
  // signature captured elsewhere is useless here.
  const message = [
    `${new URL(config.webOrigin).host} wants you to prove you control this wallet.`,
    ``,
    `X account: @${req.user!.x_handle}`,
    `X user id: ${req.user!.x_user_id}`,
    `Nonce: ${nonce}`,
    `Issued at: ${new Date().toISOString()}`,
    ``,
    `Signing costs nothing and authorises no transfer.`,
  ].join('\n');
  res.json({ message, nonce });
});

app.post('/api/wallet/verify', requireAuth, requireCsrf, limiter('verify', 10, 600), async (req: AuthedRequest, res) => {
  const { wallet, message, signature, nonce } = req.body ?? {};
  if (!isValidAddress(wallet)) return fail(res, 400, 'That is not a valid Solana address');
  if (typeof message !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
    return fail(res, 400, 'Missing signature');
  }

  // Nonce is consumed whether or not the signature checks out.
  const { rows } = await db.query(
    `DELETE FROM wallet_nonces
      WHERE nonce = $1 AND user_id = $2 AND created_at > now() - ($3 || ' minutes')::interval
      RETURNING nonce`,
    [nonce, req.user!.id, String(config.limits.walletNonceTtlMinutes)],
  );
  if (rows.length === 0) return fail(res, 400, 'That challenge expired. Try connecting again.');
  if (!message.includes(`Nonce: ${nonce}`) || !message.includes(`X user id: ${req.user!.x_user_id}`)) {
    return fail(res, 400, 'Signed message does not match the challenge');
  }

  let valid = false;
  try {
    valid = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signature),
      new PublicKey(wallet).toBytes(),
    );
  } catch {
    valid = false;
  }
  if (!valid) return fail(res, 400, 'Signature did not verify');

  // One wallet, one X account. Re-verifying a wallet you already have linked is
  // a no-op success (this is what caused spurious "linked to another account"
  // errors when the UI re-prompted after an auto-reconnect race). Only a wallet
  // genuinely held by a DIFFERENT account is rejected.
  const { rows: taken } = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE wallet = $1`,
    [wallet],
  );
  const heldByOther = taken.find((r) => r.id !== req.user!.id);
  if (heldByOther) {
    return fail(res, 409, 'That wallet is already linked to another X account');
  }
  if (taken.some((r) => r.id === req.user!.id)) {
    // Already linked to this same account — nothing to do.
    return res.json({ wallet, alreadyLinked: true });
  }

  await db.query(
    `UPDATE users SET wallet = $2, wallet_verified_at = now() WHERE id = $1`,
    [req.user!.id, wallet],
  );
  res.json({ wallet });
});

// Link an EVM (Robinhood Chain) address. Reuses the same challenge; verifies an
// EVM personal_sign via viem. A Solana address can't receive AI, so users who
// want to send/receive on Robinhood Chain link a 0x address here too.
app.post('/api/wallet/verify-evm', requireAuth, requireCsrf, limiter('verify', 10, 600), async (req: AuthedRequest, res) => {
  const { address, message, signature, nonce } = req.body ?? {};
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return fail(res, 400, 'That is not a valid EVM address');
  }
  if (typeof message !== 'string' || typeof signature !== 'string' || typeof nonce !== 'string') {
    return fail(res, 400, 'Missing signature');
  }

  const { rows } = await db.query(
    `DELETE FROM wallet_nonces
      WHERE nonce = $1 AND user_id = $2 AND created_at > now() - ($3 || ' minutes')::interval
      RETURNING nonce`,
    [nonce, req.user!.id, String(config.limits.walletNonceTtlMinutes)],
  );
  if (rows.length === 0) return fail(res, 400, 'That challenge expired. Try connecting again.');
  if (!message.includes(`Nonce: ${nonce}`) || !message.includes(`X user id: ${req.user!.x_user_id}`)) {
    return fail(res, 400, 'Signed message does not match the challenge');
  }

  let valid = false;
  try {
    const { verifyMessage } = await import('viem');
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) return fail(res, 400, 'Signature did not verify');

  const normalized = address.toLowerCase();
  const { rows: taken } = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE lower(evm_wallet) = $1`,
    [normalized],
  );
  const heldByOther = taken.find((r) => r.id !== req.user!.id);
  if (heldByOther) return fail(res, 409, 'That wallet is already linked to another X account');
  if (taken.some((r) => r.id === req.user!.id)) return res.json({ address, alreadyLinked: true });

  await db.query(
    `UPDATE users SET evm_wallet = $2, evm_verified_at = now() WHERE id = $1`,
    [req.user!.id, address],
  );
  res.json({ address });
});

// -------------------------------------------------------------- approvals

app.get('/api/intents/:id', requireAuth, async (req: AuthedRequest, res) => {
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  const viewToken = tokenBySymbol(intent.token_symbol ?? 'SOL');
  res.json({
    id: intent.id,
    to: intent.recipient_x_handle,
    amount: fmtAmount(intent.lamports, intent.token_symbol),
    token: intent.token_symbol ?? 'SOL',
    logo: logoFor(intent.token_symbol),
    chain: viewToken?.chain ?? 'solana',
    contract: viewToken?.contract ?? null,
    amountBase: intent.lamports,
    route: intent.route,
    status: intent.status,
    expiresAt: intent.expires_at,
    recipientWallet: intent.recipient_wallet,
    signature: intent.tx_signature,
    // "{sig}" is replaced client-side, so the link is right for every chain.
    explorerTx: explorerTxUrl(intent.chain ?? 'solana', '{sig}', config.solana.cluster),
  });
});

app.get('/api/intents/:id/preflight', requireAuth, limiter('preflight', 120, 600), async (req: AuthedRequest, res) => {
  if (!req.user!.wallet) return fail(res, 400, 'Connect a wallet first');
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  try {
    res.json(await preflightIntent(intent, req.user!.wallet));
  } catch (err) {
    if (err instanceof IntentError) return fail(res, 409, err.message);
    console.error('preflight failed:', err);
    fail(res, 502, 'Could not check your balance right now.');
  }
});

app.post('/api/intents/:id/transaction', requireAuth, requireCsrf, limiter('build', 60, 600), async (req: AuthedRequest, res) => {
  if (!req.user!.wallet) return fail(res, 400, 'Connect a wallet first');
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  try {
    const built = await buildIntentTransaction(intent, req.user!.wallet);
    res.json(built);
  } catch (err) {
    if (err instanceof IntentError) return fail(res, 409, err.message);
    console.error('build failed:', err);
    fail(res, 500, 'Could not build the transaction');
  }
});

app.post('/api/intents/:id/confirm', requireAuth, requireCsrf, limiter('confirm', 60, 600), async (req: AuthedRequest, res) => {
  const { signature } = req.body ?? {};
  const isSolSig = typeof signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature);
  const isEvmHash = typeof signature === 'string' && /^0x[a-fA-F0-9]{64}$/.test(signature);
  if (!isSolSig && !isEvmHash) {
    return fail(res, 400, 'Invalid transaction signature');
  }
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  // EVM (robinhood) confirmation verifies against the chain and doesn't use the
  // Solana wallet; only require a Solana wallet for Solana intents.
  if (intent.chain === 'solana' && !req.user!.wallet) {
    return fail(res, 400, 'Connect a wallet first');
  }
  try {
    await confirmIntent(intent, signature, req.user!.wallet ?? '');
    // If this tip paid a payment request, close the request.
    await db.query(
      `UPDATE payment_requests r
          SET status = 'paid', paid_by_user_id = t.sender_user_id, paid_intent_id = t.id,
              tx_signature = t.tx_signature, paid_at = now()
         FROM tip_intents t
        WHERE t.id = $1 AND t.status = 'confirmed' AND r.id = t.request_id AND r.status = 'open'`,
      [intent.id],
    );
    res.json({ status: 'confirmed', signature });
  } catch (err) {
    if (err instanceof IntentError) return fail(res, 409, err.message);
    console.error('confirm failed:', err);
    fail(res, 500, 'Could not confirm the transaction');
  }
});

// ------------------------------------------------------------------ claims

/**
 * Co-sign a claim. The attestor asserts only that this wallet belongs to this X
 * account; the returned transaction still needs the recipient's own signature,
 * and the program only pays out to the signing recipient. So this endpoint
 * cannot be abused to move an escrow anywhere else.
 */
app.post('/api/claims/:pda', requireAuth, requireCsrf, limiter('claim', 30, 600), async (req: AuthedRequest, res) => {
  if (!config.solana.escrowEnabled) return fail(res, 503, 'Claims are not enabled on this server');
  const wallet = req.user!.wallet;
  if (!wallet) return fail(res, 400, 'Connect a wallet first');

  const { rows } = await db.query<{
    pda: string;
    sender_wallet: string;
    lamports: string;
    recipient_x_hash: string;
    status: string;
  }>(
    `SELECT pda, sender_wallet, lamports, recipient_x_hash, status
       FROM escrows WHERE pda = $1 AND recipient_x_user_id = $2`,
    [req.params.pda, req.user!.x_user_id],
  );
  const escrow = rows[0];
  if (!escrow) return fail(res, 404, 'Nothing to claim here');
  if (escrow.status !== 'funded') return fail(res, 409, `This tip was already ${escrow.status}.`);

  // Belt and braces: the hash on the record must match this X account.
  if (escrow.recipient_x_hash !== recipientXHash(req.user!.x_user_id).toString('hex')) {
    return fail(res, 403, 'This tip is not addressed to your account');
  }

  const pda = new PublicKey(escrow.pda);
  const onChain = await connection.getAccountInfo(pda);
  if (!onChain) return fail(res, 409, 'This escrow is no longer on chain');

  const ix = claimIx({
    pda,
    sender: new PublicKey(escrow.sender_wallet),
    recipient: new PublicKey(wallet),
  });
  const built = await buildUnsigned(new PublicKey(wallet), [ix]);

  // Partially sign as attestor; the recipient's wallet adds the rest.
  const tx = Transaction.from(Buffer.from(built.base64, 'base64'));
  tx.partialSign(attestorKeypair());

  await db.query(
    `INSERT INTO attestations (escrow_pda, x_user_id, wallet) VALUES ($1, $2, $3)`,
    [escrow.pda, req.user!.x_user_id, wallet],
  );

  res.json({
    base64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    amount: lamportsToSol(BigInt(escrow.lamports)),
    token: 'SOL',
  });
});

app.post('/api/claims/:pda/confirm', requireAuth, requireCsrf, async (req: AuthedRequest, res) => {
  const { signature } = req.body ?? {};
  if (typeof signature !== 'string') return fail(res, 400, 'Invalid signature');
  const info = await connection.getAccountInfo(new PublicKey(req.params.pda));
  if (info) return fail(res, 409, 'That claim has not settled yet. Refresh in a moment.');
  await db.query(
    `UPDATE escrows SET status = 'claimed', claim_signature = $2
      WHERE pda = $1 AND recipient_x_user_id = $3 AND status = 'funded'`,
    [req.params.pda, signature, req.user!.x_user_id],
  );
  res.json({ status: 'claimed' });
});

// ---------------------------------------------------------------- members

/** Only https images from X's CDN, upsized from the 48px default. */
function avatarFor(url: string | null): string | null {
  if (!url || !/^https:\/\/(pbs|abs)\.twimg\.com\//.test(url)) return null;
  return url.replace('_normal.', '_bigger.');
}

/** Newest sign-ups first. Signed-in users only, so it can't be scraped anonymously. */
app.get('/api/users', requireAuth, limiter('members', 120, 600), async (req: AuthedRequest, res) => {
  const before = typeof req.query.before === 'string' && /^\d+$/.test(req.query.before) ? req.query.before : null;
  const limit = 30;
  const [{ rows }, count] = await Promise.all([
    db.query<{ id: string; x_handle: string; avatar_url: string | null; wallet: string | null; created_at: string }>(
      `SELECT id, x_handle, avatar_url, wallet, created_at
         FROM users
        WHERE x_handle IS NOT NULL AND x_user_id NOT LIKE 'dev-%'
          AND ($1::bigint IS NULL OR id < $1::bigint)
        ORDER BY id DESC
        LIMIT ${limit + 1}`,
      [before],
    ),
    db.query<{ total: string; with_wallet: string }>(
      `SELECT count(*) AS total, count(wallet) AS with_wallet
         FROM users WHERE x_handle IS NOT NULL AND x_user_id NOT LIKE 'dev-%'`,
    ),
  ]);
  const page = rows.slice(0, limit);
  res.json({
    total: Number(count.rows[0].total),
    withWallet: Number(count.rows[0].with_wallet),
    users: page.map((u) => ({
      id: u.id,
      handle: u.x_handle,
      avatar: avatarFor(u.avatar_url),
      wallet: u.wallet,
      joinedAt: u.created_at,
    })),
    nextBefore: rows.length > limit ? page[page.length - 1].id : null,
  });
});

/** Handle search for the Send page: people who can actually receive (wallet linked). */
app.get('/api/users/search', requireAuth, limiter('search', 240, 600), async (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^\w{1,15}$/.test(q)) return res.json({ users: [] });
  const { rows } = await db.query<{ id: string; x_handle: string; avatar_url: string | null; wallet: string }>(
    `SELECT id, x_handle, avatar_url, wallet
       FROM users
      WHERE wallet IS NOT NULL AND x_handle IS NOT NULL AND id <> $2
        AND lower(x_handle) LIKE $3
      ORDER BY (lower(x_handle) = $1) DESC, length(x_handle), x_handle
      LIMIT 10`,
    // "_" is a LIKE wildcard and is legal in X handles, so escape it.
    [q, req.user!.id, q.replace(/_/g, '\\_') + '%'],
  );
  res.json({
    users: rows.map((u) => ({ id: u.id, handle: u.x_handle, avatar: avatarFor(u.avatar_url), wallet: u.wallet })),
  });
});

// ---------------------------------------------------------------- balances

/**
 * The signed-in user's balances for the tokens XLedger can send, read from
 * their linked wallet. Only the associated token account counts, because that
 * is the account a transfer is built from.
 */
app.get('/api/balances', requireAuth, limiter('balances', 60, 600), async (req: AuthedRequest, res) => {
  const wallet = req.user!.wallet;
  if (!wallet) return res.json({ wallet: null, tokens: [] });
  const owner = new PublicKey(wallet);
  try {
    const [lamports, legacy, t22] = await Promise.all([
      connection.getBalance(owner, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, 'confirmed'),
      connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, 'confirmed'),
    ]);
    const held = new Map<string, bigint>();
    for (const [accounts, programId] of [
      [legacy, TOKEN_PROGRAM_ID],
      [t22, TOKEN_2022_PROGRAM_ID],
    ] as const) {
      for (const a of accounts.value) {
        const info = (a.account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } })
          .parsed?.info;
        if (!info?.mint || !info.tokenAmount?.amount) continue;
        const ata = getAssociatedTokenAddressSync(new PublicKey(info.mint), owner, false, programId);
        if (!ata.equals(a.pubkey)) continue;
        held.set(info.mint, (held.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
    }
    const tokens = TOKENS.filter((t) => t.chain === 'solana').map((t) => {
      const balance = t.mint ? held.get(t.mint.toBase58()) ?? 0n : BigInt(lamports);
      return {
        symbol: t.symbol,
        name: t.name,
        logo: t.logoURI ?? null,
        decimals: t.decimals,
        balance: balance.toString(),
        display: fromBaseUnits(balance, t),
        transferFeeBps: t.transferFeeBps ?? 0,
      };
    });
    res.json({ wallet, lamports: String(lamports), tokens });
  } catch (err) {
    console.error('balances failed:', err);
    fail(res, 502, 'Could not read your wallet balances. Try again in a moment.');
  }
});

// ------------------------------------------------------ send from the web

/**
 * Create a tip from the Send page. Same record the bot creates from a mention,
 * so it goes through the same approval page and the sender still signs the
 * exact transfer in their own wallet. Recipients must have a linked wallet.
 */
app.post('/api/intents', requireAuth, requireCsrf, limiter('web-intent', 30, 3600), async (req: AuthedRequest, res) => {
  const u = req.user!;
  if (!u.wallet) return fail(res, 400, 'Link a wallet on your account page first.');
  const { toUserId, token: symbol, amount } = req.body ?? {};
  if (typeof toUserId !== 'string' || !/^\d+$/.test(toUserId)) return fail(res, 400, 'Pick someone to send to.');
  const token = typeof symbol === 'string' ? tokenBySymbol(symbol) : null;
  if (!token || token.chain !== 'solana') return fail(res, 400, "That token can't be sent from here yet.");
  if (typeof amount !== 'string') return fail(res, 400, 'Enter an amount.');

  let base: bigint;
  try {
    base = toBaseUnits(amount.trim(), token);
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : 'Invalid amount');
  }
  const amountError = validateTipAmount(base);
  if (amountError) return fail(res, 400, amountError);

  const { rows } = await db.query<{ x_user_id: string; x_handle: string | null; wallet: string | null }>(
    `SELECT x_user_id, x_handle, wallet FROM users WHERE id = $1`,
    [toUserId],
  );
  const recipient = rows[0];
  if (!recipient) return fail(res, 404, 'That account was not found.');
  if (recipient.x_user_id === u.x_user_id || recipient.wallet === u.wallet) {
    return fail(res, 400, "You can't send to yourself.");
  }
  if (!recipient.wallet) return fail(res, 409, `@${recipient.x_handle} hasn't linked a wallet yet.`);

  const intent = await createIntent({
    senderUserId: u.id,
    recipientXUserId: recipient.x_user_id,
    recipientXHandle: recipient.x_handle,
    amount: base,
    token,
    sourceTweetId: null,
  });
  if (!intent || typeof intent === 'string') return fail(res, 409, 'Could not create that transfer. Try again.');
  res.json({ id: intent.id });
});

// -------------------------------------------------------- payment requests

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestRow {
  id: string;
  token_symbol: string;
  amount: string;
  note: string | null;
  status: string;
  created_at: string;
  paid_at: string | null;
  tx_signature: string | null;
  requester_id: string;
  requester_handle: string | null;
  requester_avatar: string | null;
  requester_wallet: string | null;
  requester_x_user_id: string;
  payer_handle: string | null;
}

const REQUEST_SELECT = `
  SELECT r.id, r.token_symbol, r.amount, r.note, r.status, r.created_at, r.paid_at, r.tx_signature,
         u.id AS requester_id, u.x_handle AS requester_handle, u.avatar_url AS requester_avatar,
         u.wallet AS requester_wallet, u.x_user_id AS requester_x_user_id,
         p.x_handle AS payer_handle
    FROM payment_requests r
    JOIN users u ON u.id = r.requester_user_id
    LEFT JOIN users p ON p.id = r.paid_by_user_id`;

function requestView(r: RequestRow) {
  return {
    id: r.id,
    link: `${config.webOrigin}/pay/${r.id}`,
    requester: r.requester_handle,
    requesterAvatar: avatarFor(r.requester_avatar),
    amount: fmtAmount(r.amount, r.token_symbol),
    token: r.token_symbol,
    logo: logoFor(r.token_symbol),
    note: r.note,
    status: r.status,
    paidBy: r.payer_handle,
    txUrl: r.tx_signature ? explorerTxUrl('solana', r.tx_signature, config.solana.cluster) : null,
    createdAt: r.created_at,
    paidAt: r.paid_at,
  };
}

/** Create a "pay me" link for a fixed amount of one Solana token. */
app.post('/api/requests', requireAuth, requireCsrf, limiter('request-create', 30, 3600), async (req: AuthedRequest, res) => {
  const u = req.user!;
  if (!u.wallet) return fail(res, 400, 'Link a wallet on your account page first, so you can be paid.');
  const { token: symbol, amount, note } = req.body ?? {};
  const token = typeof symbol === 'string' ? tokenBySymbol(symbol) : null;
  if (!token || token.chain !== 'solana') return fail(res, 400, 'Pick a supported Solana token.');
  if (typeof amount !== 'string') return fail(res, 400, 'Enter an amount.');
  let base: bigint;
  try {
    base = toBaseUnits(amount.trim(), token);
  } catch (err) {
    return fail(res, 400, err instanceof Error ? err.message : 'Invalid amount');
  }
  const amountError = validateTipAmount(base);
  if (amountError) return fail(res, 400, amountError);
  const cleanNote =
    typeof note === 'string' ? note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) || null : null;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_requests (requester_user_id, token_symbol, amount, note)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [u.id, token.symbol, base.toString(), cleanNote],
  );
  res.json({ id: rows[0].id, link: `${config.webOrigin}/pay/${rows[0].id}` });
});

/** The signed-in user's own requests, newest first. */
app.get('/api/requests', requireAuth, async (req: AuthedRequest, res) => {
  const { rows } = await db.query<RequestRow>(
    `${REQUEST_SELECT} WHERE r.requester_user_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json({ requests: rows.map(requestView) });
});

/** Public: anyone with the link can see what is being asked for (no wallet shown). */
app.get('/api/requests/:id', limiter('request-view', 120, 600), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Request not found');
  const { rows } = await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
  if (!rows[0]) return fail(res, 404, 'Request not found');
  res.json({ ...requestView(rows[0]), payable: Boolean(rows[0].requester_wallet) });
});

/**
 * Pay a request: creates a tip intent from the signed-in user to the
 * requester and returns it, so the payer lands on the normal approval page.
 * Re-opening the link reuses a still-valid pending intent instead of piling up
 * duplicates.
 */
app.post('/api/requests/:id/pay', requireAuth, requireCsrf, limiter('request-pay', 30, 3600), async (req: AuthedRequest, res) => {
  const payer = req.user!;
  if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Request not found');
  if (!payer.wallet) return fail(res, 400, 'Link a wallet on your account page first.');
  const { rows } = await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
  const r = rows[0];
  if (!r) return fail(res, 404, 'Request not found');
  if (r.status !== 'open') return fail(res, 409, `This request is already ${r.status}.`);
  if (r.requester_id === payer.id) return fail(res, 400, "This is your own request. Share the link with whoever is paying.");
  if (!r.requester_wallet) return fail(res, 409, `@${r.requester_handle} has no wallet linked right now.`);
  if (r.requester_wallet === payer.wallet) return fail(res, 400, "You can't pay your own wallet.");

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM tip_intents
      WHERE request_id = $1 AND sender_user_id = $2
        AND status = 'awaiting_approval' AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [r.id, payer.id],
  );
  if (existing.rows[0]) return res.json({ intentId: existing.rows[0].id });

  const token = tokenBySymbol(r.token_symbol);
  if (!token) return fail(res, 409, 'That token is no longer supported.');
  const intent = await createIntent({
    senderUserId: payer.id,
    recipientXUserId: r.requester_x_user_id,
    recipientXHandle: r.requester_handle,
    amount: BigInt(r.amount),
    token,
    sourceTweetId: null,
    requestId: r.id,
  });
  if (!intent || typeof intent === 'string') return fail(res, 409, 'Could not start that payment. Try again.');
  res.json({ intentId: intent.id });
});

app.post('/api/requests/:id/cancel', requireAuth, requireCsrf, async (req: AuthedRequest, res) => {
  if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Request not found');
  const { rowCount } = await db.query(
    `UPDATE payment_requests SET status = 'cancelled'
      WHERE id = $1 AND requester_user_id = $2 AND status = 'open'`,
    [req.params.id, req.user!.id],
  );
  if (!rowCount) return fail(res, 409, 'Only your own open requests can be cancelled.');
  res.json({ status: 'cancelled' });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serving the built frontend from this process keeps the API and the page on
// one origin, which removes CORS and all the third-party-cookie problems that
// come with splitting them across subdomains.
if (config.serveWeb) {
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  if (!existsSync(webDist)) {
    throw new Error(`SERVE_WEB=true but ${webDist} does not exist. Run: cd web && npm run build`);
  }

  // Open Graph / Twitter card tags. X's crawler scrapes the page when a link is
  // tweeted and renders a preview from these. The approval pages are a
  // client-rendered SPA, so we inject the tags server-side into the HTML shell
  // before React loads — otherwise the crawler sees an empty page and shows no
  // card. Read the shell once and keep a copy with the card tags in <head>.
  const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');
  const cardTags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="XLedger" />`,
    `<meta property="og:title" content="Confirm your transaction" />`,
    `<meta property="og:description" content="Review and sign it in your own wallet. XLedger never holds your funds." />`,
    `<meta property="og:image" content="${config.baseUrl}/card.png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="Confirm your transaction" />`,
    `<meta name="twitter:description" content="Review and sign it in your own wallet." />`,
    `<meta name="twitter:image" content="${config.baseUrl}/card.png" />`,
  ].join('\n    ');
  const indexWithCard = indexHtml.replace('</head>', `    ${cardTags}\n  </head>`);

  app.use(
    express.static(webDist, {
      index: false,
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-store');
        else if (/\.[0-9a-f]{8,}\./.test(path))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // Pay links get their own preview, so a shared link reads "@you requested 5 USDC".
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  app.get('/pay/:id', async (req, res, next) => {
    if (!UUID_RE.test(req.params.id)) return next();
    try {
      const { rows } = await db.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [req.params.id]);
      const r = rows[0];
      if (!r) return next();
      const v = requestView(r);
      const title = esc(`@${v.requester} requested ${v.amount} ${v.token}`);
      const desc = esc(v.note ? `“${v.note}” · Pay it from your own wallet on XLedger.` : 'Pay it from your own wallet on XLedger.');
      const tags = [
        `<meta property="og:type" content="website" />`,
        `<meta property="og:site_name" content="XLedger" />`,
        `<meta property="og:title" content="${title}" />`,
        `<meta property="og:description" content="${desc}" />`,
        `<meta property="og:image" content="${config.baseUrl}/card.png" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:title" content="${title}" />`,
        `<meta name="twitter:description" content="${desc}" />`,
        `<meta name="twitter:image" content="${config.baseUrl}/card.png" />`,
      ].join('\n    ');
      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(indexHtml.replace('</head>', `    ${tags}\n  </head>`));
    } catch {
      next();
    }
  });

  app.get(/^\/(?!api|auth|health).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(indexWithCard);
  });
}

app.use((_req, res) => fail(res, 404, 'Not found'));

/**
 * Schema bits the new members/avatar features need, applied at boot so a deploy
 * works even before `npm run migrate` is run. Both statements are idempotent.
 */
async function ensureSchema(): Promise<void> {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`);
  await db.query(`CREATE INDEX IF NOT EXISTS users_handle_lower_idx ON users (lower(x_handle))`);
  await db.query(`CREATE TABLE IF NOT EXISTS payment_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id BIGINT NOT NULL REFERENCES users(id),
  token_symbol      TEXT NOT NULL,
  amount            NUMERIC(78,0) NOT NULL CHECK (amount > 0),  -- base units
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'open',              -- open | paid | cancelled
  paid_by_user_id   BIGINT REFERENCES users(id),
  paid_intent_id    UUID,
  tx_signature      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
)`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS requests_requester_idx ON payment_requests(requester_user_id, created_at DESC)`,
  );
  await db.query(`ALTER TABLE tip_intents ADD COLUMN IF NOT EXISTS request_id UUID`);
}

/** Fill in profile pictures for accounts created before avatars were stored. */
async function backfillAvatars(): Promise<void> {
  const { rows } = await db.query<{ x_user_id: string }>(
    `SELECT x_user_id FROM users
      WHERE avatar_url IS NULL AND x_user_id ~ '^[0-9]+$'
      ORDER BY id DESC LIMIT 100`,
  );
  if (rows.length === 0) return;
  const found = await lookupUsersByIds(rows.map((r) => r.x_user_id));
  for (const u of found) {
    if (!u.profile_image_url) continue;
    await db.query(`UPDATE users SET avatar_url = $2, x_handle = $3 WHERE x_user_id = $1`, [
      u.id,
      u.profile_image_url,
      u.username,
    ]);
  }
  console.log(`avatars: backfilled ${found.length} of ${rows.length}`);
}

void ensureSchema()
  .then(() => backfillAvatars())
  .catch((err) => console.error('startup schema/avatar step failed:', err));
setInterval(() => void backfillAvatars().catch(() => {}), 6 * 60 * 60 * 1000).unref();

const server = app.listen(config.port, () => {
  console.log(`listening on :${config.port} (${config.baseUrl})`);
  console.log(`cluster: ${config.solana.cluster}`);
  console.log(`escrow: ${config.solana.escrowEnabled ? 'enabled' : 'disabled (direct tips only)'}`);
  if (config.solana.escrowEnabled) {
    console.log(`attestor pubkey ${attestorKeypair().publicKey.toBase58()}`);
  }
  if (!config.x.configured) console.warn('X sign-in unavailable: X_CLIENT_ID/SECRET not set');
});

// Containers send SIGTERM on deploy; finish in-flight requests before exiting.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal} received, draining`);
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
