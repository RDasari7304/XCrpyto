import { useState } from 'react';

/**
 * A coin badge. Shows the token's logo from the CDN when available; if there's
 * no URL or the image fails to load, falls back to a monogram (first 1–2 chars
 * of the symbol) so every token always renders something clean.
 */
export function Coin({
  symbol,
  logo,
  size = 'sm',
}: {
  symbol: string;
  logo?: string | null;
  size?: 'sm' | 'lg';
}) {
  const [broken, setBroken] = useState(false);
  const cls = `coin ${size === 'lg' ? 'coin-lg' : 'coin-sm'}`;
  const showImg = logo && !broken;
  return (
    <span className={cls} aria-hidden="true">
      {showImg ? (
        <img src={logo} alt="" onError={() => setBroken(true)} />
      ) : (
        <span>{symbol.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
