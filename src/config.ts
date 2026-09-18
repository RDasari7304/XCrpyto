import 'dotenv/config';
import { Pool } from 'pg';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const databaseUrl = req('DATABASE_URL');

/**
 * Escrow (tips to people who have not joined yet) needs the on-chain program
 * deployed. Until then the app runs in direct-only mode: tips to registered
 * recipients work, and the bot tells the sender to invite anyone else.
 */
const escrowEnabled = process.env.ESCROW_ENABLED === 'true';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: req('BASE_URL'),
  webOrigin: process.env.WEB_ORIGIN ?? req('BASE_URL'),
  isProd: process.env.NODE_ENV === 'production',
  /** Serve the built frontend from this process, so everything is one origin. */
  serveWeb: process.env.SERVE_WEB === 'true',

  databaseUrl,
  sessionPepper: req('SESSION_PEPPER'),

  /**
   * Optional: only real X sign-in and the mention poller need these, so the API
   * still boots without them (dev login, seeded intents).
   */
  x: {
    clientId: process.env.X_CLIENT_ID ?? '',
    clientSecret: process.env.X_CLIENT_SECRET ?? '',
    botBearer: process.env.X_BOT_TOKEN ?? '',
    botUserId: process.env.X_BOT_USER_ID ?? '',
    botHandle: (process.env.X_BOT_HANDLE ?? 'XCryptoBot').replace(/^@/, ''),
    get configured(): boolean {
      return Boolean(process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET);
    },
  },

  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899',
    cluster: process.env.SOLANA_CLUSTER ?? 'localnet',
    escrowEnabled,
  },

  limits: {
    minTipLamports: BigInt(process.env.MIN_TIP_LAMPORTS ?? '1000000'),
    maxTipLamports: BigInt(process.env.MAX_TIP_LAMPORTS ?? '5000000000'),
    intentTtlMinutes: 30,
    escrowTtlDays: 30,
    walletNonceTtlMinutes: 10,
  },
};

/** Only required when escrow is on, so direct-only deploys need no program. */
export function escrowProgramId(): PublicKey {
  return new PublicKey(req('ESCROW_PROGRAM_ID'));
}

let attestor: Keypair | null = null;
/**
 * Identity oracle key. Not a custody key: on-chain claims also require the
 * recipient's own wallet signature, so this alone cannot move a lamport.
 */
export function attestorKeypair(): Keypair {
  if (!attestor) attestor = Keypair.fromSecretKey(bs58.decode(req('ATTESTOR_SECRET_KEY')));
  return attestor;
}

if (escrowEnabled) {
  // Fail fast at boot rather than at the first claim.
  escrowProgramId();
  attestorKeypair();
}

// Managed Postgres (Neon, Supabase, RDS, Render) requires TLS. Local does not.
const needsSsl = /[?&]sslmode=(require|verify-full|verify-ca)/.test(databaseUrl);
export const db = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
});

db.on('error', (err) => console.error('idle pg client error:', err.message));

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Decimal SOL string -> lamports, with no float anywhere in the path. */
export function solToLamports(input: string): bigint {
  if (!/^\d{1,12}(\.\d{1,9})?$/.test(input)) throw new Error('Invalid amount');
  const [whole, frac = ''] = input.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'));
}

export function lamportsToSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / LAMPORTS_PER_SOL}${frac ? '.' + frac : ''}`;
}
