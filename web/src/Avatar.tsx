import { useState } from 'react';

/** X profile picture with an initials fallback when there's no image or it fails to load. */
export function Avatar({ handle, src, size = 40 }: { handle: string; src?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.34) };
  return (
    <span className="avatar-img" style={style} aria-hidden="true">
      {src && !broken ? (
        <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span>{handle.slice(0, 2).toUpperCase()}</span>
      )}
    </span>
  );
}
