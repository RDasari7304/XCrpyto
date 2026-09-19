import { PublicKey } from '@solana/web3.js';

/**
 * The assets XCrypto can move. SOL is native; the rest are SPL tokens,
 * identified by their mint address. Amounts are always handled in the token's
 * smallest unit (lamports for SOL, "base units" for SPL) as bigint — never
 * floats — using each token's `decimals`.
 *
 * A curated allowlist, on purpose: matching by ticker means "USDC" always
 * resolves to the real Circle mint, not a scam token that reuses the symbol.
 * Adding a token is one entry here.
 *
 * NOTE: the mints below are Solana MAINNET addresses. On devnet these tokens
 * either don't exist or use different mints, so SPL tips only work on mainnet.
 */
export interface TokenInfo {
  symbol: string;
  name: string;
  /** null for native SOL; a mint address for SPL tokens. */
  mint: PublicKey | null;
  decimals: number;
  /** extra spellings the parser should accept, lowercase. */
  aliases: string[];
}

export const TOKENS: TokenInfo[] = [
  {
    symbol: 'SOL',
    name: 'Solana',
    mint: null,
    decimals: 9,
    aliases: ['sol', 'solana', '$sol'],
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    decimals: 6,
    aliases: ['usdc', '$usdc', 'usd'],
  },
  {
    symbol: 'CATE',
    name: 'Cate',
    mint: new PublicKey('Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump'),
    decimals: 6, // confirmed via solscan
    aliases: ['cate', '$cate'],
  },
  {
    symbol: 'ZCAT',
    name: 'ZCat',
    mint: new PublicKey('HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR'),
    decimals: 9, // per user; verify on solscan
    aliases: ['zcat', '$zcat'],
  },
];

const BY_ALIAS = new Map<string, TokenInfo>();
for (const t of TOKENS) for (const a of t.aliases) BY_ALIAS.set(a, t);

export function tokenByAlias(word: string): TokenInfo | null {
  return BY_ALIAS.get(word.toLowerCase().trim()) ?? null;
}

export function tokenBySymbol(symbol: string): TokenInfo | null {
  return TOKENS.find((t) => t.symbol === symbol.toUpperCase()) ?? null;
}

/** All accepted spellings, for building the parser's units regex. */
export function allTokenWords(): string[] {
  // longest first so "solana" matches before "sol"
  return TOKENS.flatMap((t) => t.aliases)
    .map((a) => a.replace('$', '\\$'))
    .sort((a, b) => b.length - a.length);
}

/** Decimal string -> base units for a given token, no float in the path. */
export function toBaseUnits(input: string, token: TokenInfo): bigint {
  if (!/^\d{1,15}(\.\d{1,9})?$/.test(input)) throw new Error('Invalid amount');
  const [whole, frac = ''] = input.split('.');
  if (frac.length > token.decimals) {
    throw new Error(`${token.symbol} supports at most ${token.decimals} decimal places`);
  }
  const base = 10n ** BigInt(token.decimals);
  return BigInt(whole) * base + BigInt(frac.padEnd(token.decimals, '0'));
}

export function fromBaseUnits(amount: bigint, token: TokenInfo): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(token.decimals);
  const frac = (abs % base).toString().padStart(token.decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? '.' + frac : ''}`;
}
