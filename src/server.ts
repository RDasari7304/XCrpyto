import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express, { type Response } from 'express';
import cookieParser from 'cookie-parser';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey, Transaction } from '@solana/web3.js';
import { config, db, lamportsToSol, attestorKeypair } from './config.js';
import { beginOAuth, exchangeCode, me } from './x.js';
import {
  buildUnsigned,
  claimIx,
  connection,
  isValidAddress,
  recipientXHash,
} from './solana.js';
import {
  buildIntentTransaction,
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
      `INSERT INTO users (x_user_id, x_handle) VALUES ($1, $2)
       ON CONFLICT (x_user_id) DO UPDATE SET x_handle = EXCLUDED.x_handle
       RETURNING id`,
      [profile.id, profile.username],
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
  const [intents, waiting, sent] = await Promise.all([
    db.query(
      `SELECT id, recipient_x_handle, lamports, route, expires_at
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
      `SELECT recipient_x_handle, lamports, route, status, tx_signature, created_at
         FROM tip_intents
        WHERE sender_user_id = $1 AND status = 'confirmed'
        ORDER BY confirmed_at DESC LIMIT 20`,
      [u.id],
    ),
  ]);

  res.json({
    handle: u.x_handle,
    wallet: u.wallet,
    csrfToken: req.csrfSecret,
    cluster: config.solana.cluster,
    rpcUrl: config.solana.rpcUrl,
    botHandle: config.x.botHandle,
    escrowEnabled: config.solana.escrowEnabled,
    xSignInAvailable: config.x.configured,
    pendingApprovals: intents.rows.map((r) => ({
      id: r.id,
      to: r.recipient_x_handle,
      amountSol: lamportsToSol(BigInt(r.lamports)),
      route: r.route,
      expiresAt: r.expires_at,
    })),
    claimable: waiting.rows.map((r) => ({
      escrow: r.pda,
      from: r.sender_x_handle,
      amountSol: lamportsToSol(BigInt(r.lamports)),
      refundableAfter: r.expires_at,
    })),
    sent: sent.rows.map((r) => ({
      to: r.recipient_x_handle,
      amountSol: lamportsToSol(BigInt(r.lamports)),
      route: r.route,
      signature: r.tx_signature,
      at: r.created_at,
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

  // One wallet, one X account: otherwise two accounts could fight over the
  // same address and misroute tips.
  const { rows: taken } = await db.query(
    `SELECT 1 FROM users WHERE wallet = $1 AND id <> $2`,
    [wallet, req.user!.id],
  );
  if (taken.length > 0) return fail(res, 409, 'That wallet is already linked to another X account');

  await db.query(
    `UPDATE users SET wallet = $2, wallet_verified_at = now() WHERE id = $1`,
    [req.user!.id, wallet],
  );
  res.json({ wallet });
});

// -------------------------------------------------------------- approvals

app.get('/api/intents/:id', requireAuth, async (req: AuthedRequest, res) => {
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  res.json({
    id: intent.id,
    to: intent.recipient_x_handle,
    amountSol: lamportsToSol(BigInt(intent.lamports)),
    route: intent.route,
    status: intent.status,
    expiresAt: intent.expires_at,
    recipientWallet: intent.recipient_wallet,
    signature: intent.tx_signature,
  });
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
  if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(signature)) {
    return fail(res, 400, 'Invalid transaction signature');
  }
  const intent = await getIntentForSender(req.params.id, req.user!.id);
  if (!intent) return fail(res, 404, 'Tip request not found');
  if (!req.user!.wallet) return fail(res, 400, 'Connect a wallet first');
  try {
    await confirmIntent(intent, signature, req.user!.wallet);
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
    amountSol: lamportsToSol(BigInt(escrow.lamports)),
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

app.get('/health', (_req, res) => res.json({ ok: true }));

// Serving the built frontend from this process keeps the API and the page on
// one origin, which removes CORS and all the third-party-cookie problems that
// come with splitting them across subdomains.
if (config.serveWeb) {
  const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
  if (!existsSync(webDist)) {
    throw new Error(`SERVE_WEB=true but ${webDist} does not exist. Run: cd web && npm run build`);
  }
  // Hashed assets are immutable; index.html must never be cached or users get
  // a stale bundle pointing at deleted asset files after a deploy.
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
  app.get(/^\/(?!api|auth|health).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.use((_req, res) => fail(res, 404, 'Not found'));

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
