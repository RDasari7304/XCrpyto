/** Decimal-string <-> base-unit conversions with bigint only, mirroring the server. */

export function toBase(input: string, decimals: number): bigint | null {
  const s = input.trim();
  if (!/^\d{1,15}(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function fromBase(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / base}${frac ? '.' + frac : ''}`;
}
