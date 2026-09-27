import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../Avatar';
import { ApiError, getAccount, listMembers, loginUrl, type Member } from '../api';

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function joined(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return 'joined today';
  if (days === 1) return 'joined yesterday';
  if (days < 30) return `joined ${days} days ago`;
  return `joined ${d.toLocaleDateString()}`;
}

export default function Members() {
  const [users, setUsers] = useState<Member[]>([]);
  const [stats, setStats] = useState<{ total: number; withWallet: number } | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadPage = useCallback(async (before?: string) => {
    setLoading(true);
    try {
      const page = await listMembers(before);
      setUsers((prev) => (before ? [...prev, ...page.users] : page.users));
      setStats({ total: page.total, withWallet: page.withWallet });
      setNext(page.nextBefore);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = loginUrl('/members');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Populates the CSRF token too, like every other signed-in page.
    void getAccount()
      .then(() => loadPage())
      .catch(() => {
        window.location.href = loginUrl('/members');
      });
  }, [loadPage]);

  const copy = async (wallet: string) => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(wallet);
      setTimeout(() => setCopied((c) => (c === wallet ? null : c)), 1500);
    } catch {
      /* clipboard blocked; the full address is in the title tooltip */
    }
  };

  return (
    <>
      <h1>Members</h1>
      <p className="lede">
        {stats
          ? `${stats.total} ${stats.total === 1 ? 'person has' : 'people have'} joined · ${stats.withWallet} can receive tips`
          : 'Everyone who has joined XLedger, newest first.'}
      </p>

      {error && <p className="error">{error}</p>}

      {users.length === 0 && !loading && !error ? (
        <p className="empty">No one has joined yet.</p>
      ) : (
        <div style={{ marginTop: '1.5rem' }}>
          {users.map((u) => (
            <div className="tx" key={u.id}>
              <Avatar handle={u.handle} src={u.avatar} size={44} />
              <div className="tx-body">
                <div className="tx-line">
                  <a
                    className="tx-amt"
                    href={`https://x.com/${u.handle}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    @{u.handle}
                  </a>
                </div>
                <div className="tx-sub">
                  {u.wallet ? (
                    <button
                      className="linkish mono"
                      title={u.wallet}
                      onClick={() => void copy(u.wallet!)}
                    >
                      {copied === u.wallet ? 'Copied' : short(u.wallet)}
                    </button>
                  ) : (
                    <span>No wallet linked</span>
                  )}
                  {' · '}
                  {joined(u.joinedAt)}
                </div>
              </div>
              <div className="tx-right">
                {u.wallet ? (
                  <Link to={`/send?to=${encodeURIComponent(u.handle)}`}>
                    <button className="btn btn-ghost btn-sm">Send</button>
                  </Link>
                ) : (
                  <span className="pill">Not set up</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && <p className="muted" style={{ marginTop: '1rem' }}>Loading…</p>}
      {next && !loading && (
        <button
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: '1rem' }}
          onClick={() => void loadPage(next)}
        >
          Show more
        </button>
      )}
    </>
  );
}
