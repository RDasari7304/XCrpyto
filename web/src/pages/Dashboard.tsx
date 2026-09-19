import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import bs58 from 'bs58';
import { useWallet, WalletButton } from '../wallet';
import { Coin } from '../Coin';
import {
  getAccount,
  logout,
  walletChallenge,
  walletVerify,
  type Account,
} from '../api';

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { publicKey, signMessage, disconnect } = useWallet();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAccount(await getAccount());
    } catch {
      navigate('/', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const linkWallet = async () => {
    if (!publicKey || !signMessage) return;
    setError(null);
    setBusy(true);
    try {
      const { message, nonce } = await walletChallenge();
      const signature = await signMessage(new TextEncoder().encode(message));
      await walletVerify({
        wallet: publicKey.toBase58(),
        message,
        signature: bs58.encode(signature),
        nonce,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify that wallet');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await logout();
    await disconnect().catch(() => {});
    navigate('/', { replace: true });
  };

  if (!account) return <p className="lede">Loading…</p>;

  const connectedButUnlinked = publicKey && account.wallet !== publicKey.toBase58();
  const initials = (account.handle ?? '?').slice(0, 2).toUpperCase();

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h1>@{account.handle}</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            {account.wallet
              ? `Tips settle to ${short(account.wallet)}.`
              : 'Connect a wallet to start sending and receiving.'}
          </p>
        </div>
        <div className="profile">
          <span className="who">@{account.handle}</span>
          <span className="avatar">{initials}</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid grid-2" style={{ marginTop: '1.5rem' }}>
        {/* Left column: transactions */}
        <div>
          <h2 style={{ marginTop: 0 }}>Waiting for you to sign</h2>
          {account.pendingApprovals.length === 0 ? (
            <p className="empty">
              Nothing pending. Reply to a post with “@{account.botHandle} send 5 usdc to this user”.
            </p>
          ) : (
            account.pendingApprovals.map((p) => (
              <div className="tx" key={p.id}>
                <Coin symbol={p.token} logo={p.logo} />
                <div className="tx-body">
                  <div className="tx-line">
                    <span className="tx-amt">{p.amount}</span>
                    <span className="tx-sym">{p.token}</span>
                    <span className="tx-to">to {p.to ? `@${p.to}` : 'an unregistered account'}</span>
                  </div>
                  <div className="tx-sub">expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
                </div>
                <div className="tx-right">
                  <Link to={`/approve/${p.id}`}>
                    <button className="btn btn-primary btn-sm" style={{ width: 'auto', margin: 0 }}>
                      Review
                    </button>
                  </Link>
                </div>
              </div>
            ))
          )}

          <h2>Sent</h2>
          {account.sent.length === 0 ? (
            <p className="empty">No tips sent yet.</p>
          ) : (
            account.sent.map((s, i) => (
              <div className="tx" key={i}>
                <Coin symbol={s.token} logo={s.logo} />
                <div className="tx-body">
                  <div className="tx-line">
                    <span className="tx-amt">{s.amount}</span>
                    <span className="tx-sym">{s.token}</span>
                    <span className="tx-to">to {s.to ? `@${s.to}` : 'an unregistered account'}</span>
                  </div>
                  <div className="tx-sub">{new Date(s.at).toLocaleDateString()} · delivered</div>
                </div>
                {s.signature && (
                  <div className="tx-right">
                    <a
                      href={`https://solscan.io/tx/${s.signature}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="tx-sig mono"
                    >
                      {short(s.signature)}
                    </a>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right column: wallet */}
        <div>
          <h2 style={{ marginTop: 0 }}>Wallet</h2>
          <div className="card">
            <WalletButton />
            {connectedButUnlinked && (
              <>
                <p className="muted" style={{ margin: '1rem 0 0.75rem' }}>
                  Sign a short message to prove this wallet is yours. It authorizes no transfer and
                  costs no fee.
                </p>
                <button className="btn btn-primary" onClick={linkWallet} disabled={busy}>
                  {busy ? 'Waiting for your wallet…' : 'Prove ownership'}
                </button>
              </>
            )}
            {account.wallet && !publicKey && (
              <p className="muted" style={{ marginTop: '1rem' }}>
                {short(account.wallet)} is linked. Connect it again to sign anything.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="foot">
        <span>XCrypto never holds your funds and can't spend them.</span>
        <button className="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </>
  );
}
