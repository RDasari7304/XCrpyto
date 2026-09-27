import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ActionPanel } from '../ActionPanel';
import { getAction, type ActionMeta } from '../api';

/**
 * Public tip jar: xledger.xyz/tip/<handle>. The same Solana Action that blink
 * clients render inside X, as a normal page for everyone else. No sign-in.
 */
export default function Tip() {
  const { handle = '' } = useParams<{ handle: string }>();
  const clean = handle.replace(/^@/, '');
  const path = `/api/actions/tip/${encodeURIComponent(clean)}`;
  const [meta, setMeta] = useState<ActionMeta | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    getAction(path)
      .then(setMeta)
      .catch(() => setMissing(true));
  }, [path]);

  if (missing) {
    return (
      <>
        <h1>No tip jar here</h1>
        <p className="lede">No one by @{clean} has joined XLedger yet.</p>
        <Link to="/">What is XLedger?</Link>
      </>
    );
  }
  if (!meta) return <p className="lede">Loading…</p>;

  return (
    <>
      <div className="payer-head">
        <span className="avatar-img" style={{ width: 64, height: 64 }}>
          <img src={meta.icon} alt="" referrerPolicy="no-referrer" />
        </span>
        <div>
          <h1 style={{ margin: 0 }}>{meta.title}</h1>
          <p className="lede" style={{ margin: '0.2rem 0 0' }}>
            <a href={`https://x.com/${clean}`} target="_blank" rel="noreferrer noopener">
              x.com/{clean}
            </a>
          </p>
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <p className="muted" style={{ marginTop: 0 }}>{meta.description}</p>
        <ActionPanel path={path} compact />
      </div>

      <p className="muted center" style={{ marginTop: '1.25rem', fontSize: '0.85rem' }}>
        No account needed. You sign the exact transfer in your own wallet. Want a tip jar like this?{' '}
        <Link to="/">Join XLedger</Link>.
      </p>
    </>
  );
}
