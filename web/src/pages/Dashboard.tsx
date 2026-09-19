import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { useWallet, WalletButton } from '../wallet';
import {
  getAccount,
  logout,
  walletChallenge,
  walletVerify,
  runtimeRpcUrl,
  type Account,
} from '../api';

// Kept for parity with Approve; dashboard itself doesn't broadcast, but a shared
// connection getter avoids a stale baked-in RPC URL if we add reads later.
let _conn: Connection | null = null;
function rpc(): Connection {
  const url = runtimeRpcUrl ?? import.meta.env.VITE_RPC_URL ?? 'https://api.devnet.solana.com';
  if (!_conn || _conn.rpcEndpoint !== url) _conn = new Connection(url, 'confirmed');
  return _conn;
}
void rpc; // referenced to avoid unused warning; retained intentionally

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

  return (
    <>
      <h1>@{account.handle}</h1>
      <p className="lede">
        {account.wallet
          ? `Tips settle to ${short(account.wallet)}.`
          : 'Connect a wallet to start sending and receiving.'}
      </p>

      {error && <p className="error">{error}</p>}

      <h2>Wallet</h2>
      <div className="card">
        <WalletButton />
        {connectedButUnlinked && (
          <>
            <p className="muted" style={{ margin: '1rem 0 0.75rem' }}>
              Sign a short message to prove this wallet is yours. It authorizes no transfer and costs
              no fee.
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

      <h2>Waiting for you to sign</h2>
      {account.pendingApprovals.length === 0 ? (
        <p className="empty">
          Nothing pending. Reply to a post with “@{account.botHandle} send 5 usdc to this user”.
        </p>
      ) : (
        account.pendingApprovals.map((p) => (
          <div className="row" key={p.id}>
            <span className="row-main">
              <span className="row-amt">
                {p.amount} <span className="sym">{p.token}</span> to{' '}
                {p.to ? `@${p.to}` : 'an unregistered account'}
              </span>
              <span className="row-sub">
                expires {new Date(p.expiresAt).toLocaleTimeString()}
              </span>
            </span>
            <Link to={`/approve/${p.id}`}>
              <button className="btn btn-ghost btn-sm">Review</button>
            </Link>
          </div>
        ))
      )}

      <h2>Sent</h2>
      {account.sent.length === 0 ? (
        <p className="empty">No tips sent yet.</p>
      ) : (
        account.sent.map((s, i) => (
          <div className="row" key={i}>
            <span className="row-main">
              <span className="row-amt">
                {s.amount} <span className="sym">{s.token}</span> to{' '}
                {s.to ? `@${s.to}` : 'an unregistered account'}
              </span>
              <span className="row-sub">{new Date(s.at).toLocaleDateString()} · delivered</span>
            </span>
            {s.signature && (
              <a
                href={`https://solscan.io/tx/${s.signature}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mono"
                style={{ fontSize: '0.8rem' }}
              >
                {short(s.signature)}
              </a>
            )}
          </div>
        ))
      )}

      <div className="foot">
        <span>XCrypto never holds your funds and can't spend them.</span>
        <button className="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </>
  );
}
