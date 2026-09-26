import { config } from './config.js';
import { allTokenWords, tokenByAlias, toBaseUnits, type TokenInfo } from './tokens.js';

export type Command =
  | {
      kind: 'tip';
      amount: bigint; // base units of `token`
      token: TokenInfo;
      target: { type: 'handle'; handle: string } | { type: 'reply_author' };
    }
  | { kind: 'help' }
  | { kind: 'none' };

// Any accepted token spelling, longest-first so "solana"/"usdc" match cleanly.
const UNITS = `(?:${allTokenWords().join('|')})`;
const AMOUNT = '(\\d{1,15}(?:\\.\\d{1,9})?)';

/**
 * A mention is an instruction to the app, not an action on anyone's account.
 * Nothing here moves money; it only produces a proposal the sender must sign.
 *
 * Accepted (SOL or any supported SPL token):
 *   @XLedger_Bot send 5 usdc to @alice
 *   @XLedger_Bot send 0.25 sol to this user
 *   @XLedger_Bot tip @alice 1000 bonk
 *   @XLedger_Bot tip 1 jup            -> recipient = author of the replied-to post
 */
export function parseCommand(text: string): Command {
  const t = text.replace(/\s+/g, ' ').trim();
  const bot = new RegExp(`@${config.x.botHandle}\\b`, 'i');
  if (!bot.test(t)) return { kind: 'none' };

  const body = t.replace(bot, ' ').trim();
  if (/^\s*(help|commands|how)\b/i.test(body)) return { kind: 'help' };

  const patterns: Array<[RegExp, (m: RegExpMatchArray) => Command]> = [
    // tip @alice 1 usdc   (amount + unit captured as groups 2,3)
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+@(\\w{1,15})\\s+${AMOUNT}\\s*(${UNITS})\\b`, 'i'),
      (m) => tipTo(m[2], m[3], { type: 'handle', handle: m[1] }),
    ],
    // send 5 usdc to @alice
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*(${UNITS})\\s+to\\s+@(\\w{1,15})`, 'i'),
      (m) => tipTo(m[1], m[2], { type: 'handle', handle: m[3] }),
    ],
    // send 5 usdc to this user / them / OP / above
    [
      new RegExp(
        `\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*(${UNITS})\\s+to\\s+(?:this\\s+(?:user|guy|person)|them|him|her|op|the\\s+op|above)\\b`,
        'i',
      ),
      (m) => tipTo(m[1], m[2], { type: 'reply_author' }),
    ],
    // tip 5 usdc
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*(${UNITS})\\s*$`, 'i'),
      (m) => tipTo(m[1], m[2], { type: 'reply_author' }),
    ],
  ];

  for (const [re, build] of patterns) {
    const m = body.match(re);
    if (m) {
      try {
        return build(m);
      } catch {
        return { kind: 'none' };
      }
    }
  }
  return { kind: 'none' };
}

function tipTo(
  amount: string,
  unit: string,
  target: Extract<Command, { kind: 'tip' }>['target'],
): Command {
  const token = tokenByAlias(unit);
  if (!token) return { kind: 'none' };
  return { kind: 'tip', amount: toBaseUnits(amount, token), token, target };
}

export function validateTipAmount(amount: bigint): string | null {
  if (amount <= 0n) return 'Amount must be greater than zero.';
  return null;
}
