import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config, db } from './config.js';

export interface SessionUser {
  id: string;
  x_user_id: string;
  x_handle: string | null;
  wallet: string | null;
}

export interface AuthedRequest extends Request {
  user?: SessionUser;
  csrfSecret?: string;
}

/** Tokens are stored hashed with a server-side pepper, never in plaintext. */
function hashToken(token: string): string {
  return createHash('sha256').update(token + config.sessionPepper).digest('hex');
}

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  // API responses are JSON and should never render or frame. When this process
  // also serves the built frontend, those routes need a document policy
  // instead, so the strict one is scoped to /api and /auth only.
  const isApi = req.path.startsWith('/api') || req.path.startsWith('/auth');
  res.setHeader(
    'Content-Security-Policy',
    isApi
      ? "default-src 'none'; frame-ancestors 'none'"
      : [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "img-src 'self' data:",
          // Wallet extensions and the Solana RPC endpoint are reached from the page.
          "connect-src 'self' " + (process.env.SOLANA_RPC_URL ?? '') + ' ' + (process.env.SOLANA_WS_URL ?? ''),
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
  );
  if (config.isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/** Strict allowlist CORS. Credentials are only ever sent to the known web origin. */
export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin === config.webOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export async function createSession(
  res: Response,
  userId: string,
  userAgent?: string,
): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const csrfSecret = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_secret, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '14 days')`,
    [hashToken(token), userId, csrfSecret, userAgent?.slice(0, 300) ?? null],
  );
  res.cookie('sid', token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 14 * 24 * 3600 * 1000,
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.sid;
  if (token) await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
  res.clearCookie('sid', { path: '/' });
}

export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.sid;
  if (!token) {
    res.status(401).json({ error: 'Sign in with X to continue' });
    return;
  }
  const { rows } = await db.query<SessionUser & { csrf_secret: string }>(
    `SELECT u.id, u.x_user_id, u.x_handle, u.wallet, s.csrf_secret
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (rows.length === 0) {
    res.clearCookie('sid', { path: '/' });
    res.status(401).json({ error: 'Your session expired. Sign in again.' });
    return;
  }
  req.user = rows[0];
  req.csrfSecret = rows[0].csrf_secret;
  next();
}

/**
 * Double-submit CSRF on top of SameSite=Lax. Lax already blocks cross-site
 * POSTs from carrying the cookie; this is the second lock.
 */
export function requireCsrf(req: AuthedRequest, res: Response, next: NextFunction): void {
  const supplied = req.headers['x-csrf-token'];
  const expected = req.csrfSecret;
  if (typeof supplied !== 'string' || !expected) {
    res.status(403).json({ error: 'Missing CSRF token' });
    return;
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return;
  }
  next();
}

/** Fixed-window counter in Postgres, so it survives restarts and multiple nodes. */
export async function rateLimit(
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO rate_counters (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_counters.count + 1
     RETURNING count`,
    [bucket, windowSeconds],
  );
  return rows[0].count <= max;
}

export function limiter(name: string, max: number, windowSeconds: number) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    const who = req.user?.id ?? req.ip ?? 'unknown';
    const ok = await rateLimit(`${name}:${who}`, max, windowSeconds);
    if (!ok) {
      res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
      return;
    }
    next();
  };
}
