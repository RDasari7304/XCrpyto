/**
 * Repoints any funded escrow at your own X account so the claim flow can be
 * tested. Replaces a raw psql UPDATE, so it works the same on every platform.
 *
 *   npm run claimable -- devuser
 */
import { db } from '../src/config.js';

const handle = (process.argv[2] ?? 'devuser').replace(/^@/, '');

const { rows: users } = await db.query<{ x_user_id: string }>(
  `SELECT x_user_id FROM users WHERE x_handle = $1`,
  [handle],
);

if (!users[0]) {
  console.error(`No user @${handle}. Sign in first, then run this again.`);
  await db.end();
  process.exit(1);
}

const { rowCount } = await db.query(
  `UPDATE escrows SET recipient_x_user_id = $1 WHERE status = 'funded'`,
  [users[0].x_user_id],
);

console.log(
  rowCount
    ? `Repointed ${rowCount} escrow(s) to @${handle}. Reload the dashboard.`
    : 'No funded escrows found. Send an escrow-route tip first.',
);
await db.end();
