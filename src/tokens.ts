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
export type Chain = 'solana' | 'robinhood';

export interface TokenInfo {
  symbol: string;
  name: string;
  /** which blockchain this token lives on */
  chain: Chain;
  /**
   * Solana: mint address (null = native SOL).
   * Robinhood (EVM): ERC-20 contract address (null = native ETH gas token).
   */
  mint: PublicKey | null;
  /** EVM contract address for robinhood-chain tokens (0x…). */
  contract?: string;
  decimals: number;
  /** extra spellings the parser should accept, lowercase. */
  aliases: string[];
  /**
   * Transfer fee in basis points, for Token-2022 tokens that take a cut on
   * every transfer (e.g. ZCAT is 300 = 3%). Solana-only.
   */
  transferFeeBps?: number;
  /** Coin image URL for the UI. Falls back to a monogram badge if absent/broken. */
  logoURI?: string;
}

export const TOKENS: TokenInfo[] = [
  {
    symbol: 'SOL',
    name: 'Solana',
    chain: 'solana',
    mint: null,
    decimals: 9,
    aliases: ['sol', 'solana', '$sol'],
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'solana',
    mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    decimals: 6,
    aliases: ['usdc', '$usdc', 'usd'],
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  },
  {
    symbol: 'CATE',
    name: 'Cate',
    chain: 'solana',
    mint: new PublicKey('Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump'),
    decimals: 6, // confirmed via solscan
    aliases: ['cate', '$cate'],
  },
  {
    symbol: 'ZCAT',
    name: 'ZCat',
    chain: 'solana',
    mint: new PublicKey('HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR'),
    decimals: 9,
    transferFeeBps: 300, // 3% transfer fee (Token-2022)
    aliases: ['zcat', '$zcat'],
  },
  {
    symbol: 'ANSEM',
    name: 'Ansem',
    chain: 'solana',
    mint: new PublicKey('9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump'),
    decimals: 6, // confirmed via solscan; no transfer fee
    aliases: ['ansem', '$ansem'],
  },
  {
    symbol: 'AI',
    name: 'Artificial Inu',
    chain: 'robinhood',
    mint: null,
    contract: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
    decimals: 18, // confirmed on-chain via eth_call decimals()
    aliases: ['ai', '$ai'],
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
