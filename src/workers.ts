import { config, db, lamportsToSol } from './config.js';
import { parseCommand, validateTipAmount } from './commands.js';
import { createIntent } from './intents.js';
import { fetchMentions, lookupHandle, reply, RateLimited, type Mention } from './x.js';
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

  const amountError = validateTipAmount(cmd.lamports);
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

  // The sender must have signed in at least once, so we know which account the
  // approval link belongs to.
  const { rows } = await db.query<{ id: string; wallet: string | null }>(
    `SELECT id, wallet FROM users WHERE x_user_id = $1`,
    [m.authorId],
  );
  if (!rows[0]?.wallet) {
    await reply(
      m.id,
      `Connect a wallet first at ${config.webOrigin} — takes a minute, then this will work.`,
    );
    return;
  }

  const intent = await createIntent({
    senderUserId: rows[0].id,
    recipientXUserId: recipient.id,
    recipientXHandle: recipient.handle,
    lamports: cmd.lamports,
    sourceTweetId: m.id,
  });
  if (intent === 'recipient_not_registered') {
    await reply(
      m.id,
      `${recipient.handle ? '@' + recipient.handle : 'They'} hasn't connected a wallet yet. Ask them to set one up at ${config.webOrigin}, then try again.`,
    );
    return;
  }
  if (!intent) return; // duplicate

  const to = recipient.handle ? `@${recipient.handle}` : 'them';
  await reply(
    m.id,
    `Confirm your transaction 👇\n\n${lamportsToSol(cmd.lamports)} SOL to ${to} — sign it in your own wallet. Expires in ${config.limits.intentTtlMinutes} min.\n\n${config.webOrigin}/approve/${intent.id}`,
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
// Each poll is a billable X API read on Pay-Per-Use, so the interval directly
// sets your idle cost. Default 60s (~43k reads/month); raise MENTION_POLL_SECONDS
// on Render to cut spend further. A minute or two of reply delay is fine.
const pollSeconds = Math.max(15, Number(process.env.MENTION_POLL_SECONDS ?? 60));
void loop('mentions', pollMentions, pollSeconds * 1000);
void loop('housekeeping', expireIntents, 60_000);
