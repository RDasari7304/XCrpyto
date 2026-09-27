import { config, db } from './config.js';
import { parseCommand, validateTipAmount } from './commands.js';
import { createIntent } from './intents.js';
import { explorerTxUrl, fromBaseUnits, isEvmChain, tokenBySymbol } from './tokens.js';
import { botWhoAmI, fetchMentions, lookupHandle, reply, RateLimited, type Mention } from './x.js';
import { botOauth1Configured } from './oauth1.js';
import { rateLimit } from './security.js';

const CURSOR_KEY = 'mentions_since_id';

async function getCursor(): Promise<string | undefined> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM poll_state WHERE key = $1`,
    [CURSOR_KEY],
  );
  return rows[0]?.value;
}

async function setCursor(value: string): Promise<void> {
  await db.query(
    `INSERT INTO poll_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CURSOR_KEY, value],
  );
}

async function record(tweetId: string, outcome: string, detail?: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO processed_mentions (tweet_id, outcome, detail) VALUES ($1, $2, $3)
     ON CONFLICT (tweet_id) DO NOTHING RETURNING tweet_id`,
    [tweetId, outcome, detail?.slice(0, 500) ?? null],
  );
  return rowCount === 1;
}

async function handleMention(m: Mention): Promise<void> {
  const cmd = parseCommand(m.text);
  if (cmd.kind === 'none') {
    await record(m.id, 'ignored');
    return;
  }
  if (!(await record(m.id, cmd.kind))) return; // already handled

  if (cmd.kind === 'help') {
    await reply(
      m.id,
      `Reply to any post with "@${config.x.botHandle} send 0.1 sol to this user". I'll send you a link to review and sign it in your own wallet — I never hold your SOL. ${config.webOrigin}`,
    );
    return;
  }

  // Stop one account from spraying proposals across the timeline.
  if (!(await rateLimit(`mention:${m.authorId}`, 20, 3600))) {
    await reply(m.id, 'You have hit the hourly limit on tip requests. Try again later.');
    return;
  }

  const amountError = validateTipAmount(cmd.amount);
  if (amountError) {
    await reply(m.id, amountError);
    return;
  }

  const recipient =
    cmd.target.type === 'reply_author'
      ? m.repliedToAuthorId
        ? { id: m.repliedToAuthorId, handle: m.repliedToAuthorHandle }
        : null
      : await lookupHandle(cmd.target.handle).then((u) =>
          u ? { id: u.id, handle: u.username } : null,
        );

  if (!recipient) {
    await reply(
      m.id,
      "I couldn't tell who to send to. Reply directly to their post, or name their @handle.",
    );
    return;
  }
  if (recipient.id === m.authorId) {
    await reply(m.id, 'That is your own account.');
    return;
  }
  if (recipient.id === config.x.botUserId) return;

  // The sender must have signed in and linked the wallet for this token's chain.
  const { rows } = await db.query<{ id: string; wallet: string | null; evm_wallet: string | null }>(
    `SELECT id, wallet, evm_wallet FROM users WHERE x_user_id = $1`,
    [m.authorId],
  );
  const senderRow = rows[0];
  const needsEvm = isEvmChain(cmd.token.chain);
  if (!senderRow) {
    await reply(m.id, `Connect a wallet first at ${config.webOrigin} — takes a minute, then this will work.`);
    return;
  }
  if (needsEvm && !senderRow.evm_wallet) {
    await reply(
      m.id,
      `To send ${cmd.token.symbol} you need a linked Robinhood Chain wallet. Link one at ${config.webOrigin}, then try again.`,
    );
    return;
  }
  if (!needsEvm && !senderRow.wallet) {
    await reply(m.id, `Connect a wallet first at ${config.webOrigin} — takes a minute, then this will work.`);
    return;
  }

  const intent = await createIntent({
    senderUserId: senderRow.id,
    recipientXUserId: recipient.id,
    recipientXHandle: recipient.handle,
    amount: cmd.amount,
    token: cmd.token,
    sourceTweetId: m.id,
  });
  const who = recipient.handle ? '@' + recipient.handle : 'They';
  if (intent === 'evm_needs_wallet') {
    await reply(
      m.id,
      `${who} needs a linked Robinhood Chain wallet to receive ${cmd.token.symbol}. Ask them to link one at ${config.webOrigin}, then try again.`,
    );
    return;
  }
  if (intent === 'recipient_not_registered') {
    await reply(
      m.id,
      `${who} hasn't connected a wallet yet. Ask them to set one up at ${config.webOrigin}, then try again.`,
    );
    return;
  }
  if (intent === 'spl_needs_wallet') {
    await reply(
      m.id,
      `${who} needs a connected wallet to receive ${cmd.token.symbol}. Ask them to sign up at ${config.webOrigin}, then try again. (Holding ${cmd.token.symbol} for unregistered users isn't supported yet — only SOL.)`,
    );
    return;
  }
  if (!intent) return; // duplicate

  const to = recipient.handle ? `@${recipient.handle}` : 'them';
  await reply(
    m.id,
    `Confirm your transaction 👇\n\n${fromBaseUnits(cmd.amount, cmd.token)} ${cmd.token.symbol} to ${to} — sign it in your own wallet. Expires in ${config.limits.intentTtlMinutes} min.\n\n${config.webOrigin}/approve/${intent.id}`,
  );
}

async function pollMentions(): Promise<void> {
  const { mentions, newestId } = await fetchMentions(await getCursor());
  for (const m of [...mentions].reverse()) {
    await handleMention(m);
    await setCursor(m.id); // advance only past work that finished
  }
  if (newestId && mentions.length === 0) await setCursor(newestId);
}

/**
 * Public receipts. When a tip that started from a mention is confirmed, the bot
 * replies in that thread tagging sender and recipient with the explorer link.
 * This is how the recipient finds out they were paid, and it shows everyone in
 * the thread that the tip actually happened.
 *
 * Each row is claimed (receipt_posted_at set) BEFORE posting, so a crash or a
 * second worker can never post the same receipt twice; the worst case is one
 * missed receipt. Only tips confirmed in the last hour are eligible, so the
 * first deploy doesn't announce old test tips. Set TIP_RECEIPTS=false to turn
 * this off (each reply is a billable X API write).
 */
async function postReceipts(): Promise<void> {
  if (process.env.TIP_RECEIPTS === 'false' || !botOauth1Configured()) return;
  const { rows } = await db.query<{
    source_tweet_id: string;
    lamports: string;
    token_symbol: string;
    chain: string;
    tx_signature: string | null;
    recipient_x_handle: string | null;
    sender_handle: string | null;
  }>(
    `UPDATE tip_intents t SET receipt_posted_at = now()
       FROM users s
      WHERE s.id = t.sender_user_id
        AND t.id IN (
          SELECT id FROM tip_intents
           WHERE status = 'confirmed' AND source_tweet_id IS NOT NULL
             AND receipt_posted_at IS NULL AND tx_signature IS NOT NULL
             AND confirmed_at > now() - interval '1 hour'
           ORDER BY confirmed_at
           LIMIT 5
           FOR UPDATE SKIP LOCKED)
      RETURNING t.source_tweet_id, t.lamports, t.token_symbol, t.chain, t.tx_signature,
                t.recipient_x_handle, s.x_handle AS sender_handle`,
  );
  for (const r of rows) {
    const token = tokenBySymbol(r.token_symbol);
    const amount = token ? fromBaseUnits(BigInt(r.lamports), token) : r.lamports;
    const from = r.sender_handle ? `@${r.sender_handle}` : 'Someone';
    const to = r.recipient_x_handle ? `@${r.recipient_x_handle}` : 'you';
    const url = explorerTxUrl(r.chain, r.tx_signature!, config.solana.cluster);
    await reply(
      r.source_tweet_id,
      `✅ ${from} sent ${to} ${amount} ${r.token_symbol}.\n\nSigned in their own wallet. XLedger never holds the funds.\n\n${url}`,
    );
  }
}

/** Expire stale proposals so an old link can never be signed. */
async function expireIntents(): Promise<void> {
  await db.query(
    `UPDATE tip_intents SET status = 'expired'
      WHERE status = 'awaiting_approval' AND expires_at < now()`,
  );
  await db.query(`DELETE FROM oauth_states WHERE created_at < now() - interval '15 minutes'`);
  await db.query(`DELETE FROM wallet_nonces WHERE created_at < now() - interval '10 minutes'`);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(`DELETE FROM rate_counters WHERE window_start < now() - interval '2 days'`);
}

async function loop(name: string, fn: () => Promise<unknown>, intervalMs: number): Promise<void> {
  for (;;) {
    let wait = intervalMs;
    try {
      await fn();
    } catch (err) {
      if (err instanceof RateLimited) {
        wait = Math.max(intervalMs, err.resetEpochSeconds * 1000 - Date.now() + 1000);
        console.warn(`${name}: rate limited, sleeping ${Math.round(wait / 1000)}s`);
      } else {
        console.error(`${name}:`, err);
        wait = intervalMs * 2;
      }
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

console.log('workers starting');
console.log(`reply links point to ${config.webOrigin}`);

// Check the bot credentials once at boot so a bad token is obvious in the logs.
if (!botOauth1Configured()) {
  console.error('bot auth: X_API_KEY/SECRET and X_ACCESS_TOKEN/SECRET are not all set');
} else {
  botWhoAmI()
    .then((u) => {
      console.log(`bot auth: OK as @${u.username} (id ${u.id})`);
      if (config.x.botUserId && u.id !== config.x.botUserId) {
        console.error(`bot auth: X_BOT_USER_ID is ${config.x.botUserId} but the tokens belong to ${u.id}. Set X_BOT_USER_ID=${u.id}.`);
      }
      if (u.username.toLowerCase() !== config.x.botHandle.toLowerCase()) {
        console.error(`bot auth: X_BOT_HANDLE is ${config.x.botHandle} but the tokens belong to @${u.username}.`);
      }
    })
    .catch((err) =>
      console.error(
        'bot auth: FAILED. X rejected X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET. ' +
          'Check the token (starts with digits and a dash) and secret are not swapped, and that ' +
          'all four came from the same app. ' + (err as Error).message,
      ),
    );
}
// Each poll is a billable X API read on Pay-Per-Use, so the interval directly
// sets your idle cost. Default 60s (~43k reads/month); raise MENTION_POLL_SECONDS
// on Render to cut spend further. A minute or two of reply delay is fine.
const pollSeconds = Math.max(15, Number(process.env.MENTION_POLL_SECONDS ?? 60));
void loop('mentions', pollMentions, pollSeconds * 1000);
void loop('housekeeping', expireIntents, 60_000);
// Idempotent; lets receipts work before `npm run migrate` has been run.
void db
  .query(`ALTER TABLE tip_intents ADD COLUMN IF NOT EXISTS receipt_posted_at TIMESTAMPTZ`)
  .then(() => loop('receipts', postReceipts, 30_000))
  .catch((err) => console.error('receipts disabled, schema step failed:', err));
