/**
 * Creates a tip intent the way the mention poller would, so the approve-and-sign
 * flow can be exercised without paid X API access.
 *
 *   npm run seed -- @devuser 0.25              # -> escrow route (recipient has no wallet)
 *   npm run seed -- @devuser 0.25 --direct     # -> direct route (invents a recipient wallet)
 */
import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { config, db, solToLamports, lamportsToSol } from '../src/config.js';

const args = process.argv.slice(2);
const handle = (args.find((a) => !a.startsWith('-')) ?? 'devuser').replace(/^@/, '');
const amount = args.filter((a) => !a.startsWith('-'))[1] ?? '0.25';
const direct = args.includes('--direct');

const lamports = solToLamports(amount);

const { rows: senders } = await db.query<{ id: string; x_handle: string; wallet: string | null }>(
  `SELECT id, x_handle, wallet FROM users WHERE x_handle = $1`,
  [handle],
);
const sender = senders[0];

if (!sender) {
  console.error(`No user @${handle}. Sign in first at ${config.webOrigin}.`);
  process.exit(1);
}
if (!sender.wallet) {
  console.error(`@${handle} has no verified wallet yet. Connect one on the dashboard first.`);
  process.exit(1);
}

const recipientXUserId = `seed-${randomBytes(4).toString('hex')}`;
const recipientWallet = direct ? Keypair.generate().publicKey.toBase58() : null;

// A stand-in recipient. In the direct case they already have a wallet, which is
// what makes the poller pick the direct route over escrow.
await db.query(
  `INSERT INTO users (x_user_id, x_handle, wallet, wallet_verified_at)
   VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)`,
  [recipientXUserId, `recipient_${recipientXUserId.slice(-4)}`, recipientWallet],
);

const { rows } = await db.query<{ id: string }>(
  `INSERT INTO tip_intents
     (sender_user_id, recipient_x_user_id, recipient_x_handle, recipient_wallet,
      lamports, route, escrow_nonce, source_tweet_id, expires_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' minutes')::interval)
   RETURNING id`,
  [
    sender.id,
    recipientXUserId,
    `recipient_${recipientXUserId.slice(-4)}`,
    recipientWallet,
    lamports.toString(),
    direct ? 'direct' : 'escrow',
    direct ? null : BigInt('0x' + randomBytes(6).toString('hex')).toString(),
    `seed-${randomBytes(8).toString('hex')}`,
    String(config.limits.intentTtlMinutes),
  ],
);

console.log(`\n${lamportsToSol(lamports)} SOL, ${direct ? 'direct' : 'escrow'} route`);
console.log(`Open: ${config.webOrigin}/approve/${rows[0].id}\n`);
await db.end();
