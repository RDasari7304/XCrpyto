import { solToLamports, config } from './config.js';

export type Command =
  | {
      kind: 'tip';
      lamports: bigint;
      target: { type: 'handle'; handle: string } | { type: 'reply_author' };
    }
  | { kind: 'help' }
  | { kind: 'none' };

const UNITS = '(?:sol|solana|\\$sol)';
const AMOUNT = '(\\d{1,12}(?:\\.\\d{1,9})?)';

/**
 * A mention is an instruction to the application, not an action taken through
 * anyone's X account. Nothing here moves money; it only produces a proposal the
 * sender must open and sign.
 *
 * Accepted:
 *   @XCryptoBot send 5 sol to @alice
 *   @XCryptoBot send 0.25 SOL to this user
 *   @XCryptoBot tip @alice 1 sol
 *   @XCryptoBot tip 1 sol            -> recipient = author of the replied-to post
 */
export function parseCommand(text: string): Command {
  const t = text.replace(/\s+/g, ' ').trim();
  const bot = new RegExp(`@${config.x.botHandle}\\b`, 'i');
  if (!bot.test(t)) return { kind: 'none' };

  const body = t.replace(bot, ' ').trim();
  if (/^\s*(help|commands|how)\b/i.test(body)) return { kind: 'help' };

  const patterns: Array<[RegExp, (m: RegExpMatchArray) => Command]> = [
    // tip @alice 1 sol
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+@(\\w{1,15})\\s+${AMOUNT}\\s*${UNITS}\\b`, 'i'),
      (m) => tipTo(m[2], { type: 'handle', handle: m[1] }),
    ],
    // send 5 sol to @alice
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*${UNITS}\\s+to\\s+@(\\w{1,15})`, 'i'),
      (m) => tipTo(m[1], { type: 'handle', handle: m[2] }),
    ],
    // send 5 sol to this user / them / OP / above
    [
      new RegExp(
        `\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*${UNITS}\\s+to\\s+(?:this\\s+(?:user|guy|person)|them|him|her|op|the\\s+op|above)\\b`,
        'i',
      ),
      (m) => tipTo(m[1], { type: 'reply_author' }),
    ],
    // tip 5 sol
    [
      new RegExp(`\\b(?:tip|send|pay)\\s+${AMOUNT}\\s*${UNITS}\\s*$`, 'i'),
      (m) => tipTo(m[1], { type: 'reply_author' }),
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

function tipTo(amount: string, target: Extract<Command, { kind: 'tip' }>['target']): Command {
  return { kind: 'tip', lamports: solToLamports(amount), target };
}

export function validateTipAmount(lamports: bigint): string | null {
  if (lamports < config.limits.minTipLamports) return 'That is below the minimum tip.';
  if (lamports > config.limits.maxTipLamports) return 'That is above the maximum tip.';
  return null;
}
