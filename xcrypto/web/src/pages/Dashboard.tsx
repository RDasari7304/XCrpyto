import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Connection, Transaction } from '@solana/web3.js';
import { useWallet, WalletButton, base64ToBytes } from '../wallet';
import bs58 from 'bs58';
import {
  buildClaimTx,
  confirmClaim,
  getAccount,
  logout,
  walletChallenge,
  walletVerify,
  type Account,
} from '../api';

// A single shared RPC connection, replacing useConnection() from the adapter.
const connection = new Connection(
  import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8899',
  'confirmed',
);

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { publicKey, signMessage, signTransaction, disconnect } = useWallet();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    setBusy('link');
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
      setBusy(null);
    }
  };

  const claim = async (pda: string) => {
    if (!signTransaction) return;
    setError(null);
    setBusy(pda);
    try {
      const { base64 } = await buildClaimTx(pda);
      // Arrives already signed by the attestor; our signature completes it.
      const tx = Transaction.from(base64ToBytes(base64));
      const signed = await signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(signature, 'confirmed');
      await confirmClaim(pda, signature);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Claim failed');
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    await logout();
    await disconnect().catch(() => {});
    navigate('/', { replace: true });
  };

  if (!account) return <p className="lede">Loading…</p>;

  const connectedButUnlinked =
    publicKey && account.wallet !== publicKey.toBase58();

  return (
    <>
      <h1>@{account.handle}</h1>
      <p className="lede">
        {account.wallet
          ? `Tips settle to ${short(account.wallet)} on ${account.cluster}.`
          : 'Connect a wallet to start sending and receiving.'}
      </p>

      {error && <p className="error">{error}</p>}

      <h2>Your wallet</h2>
      <div className="slip">
        <WalletButton />
        {connectedButUnlinked && (
          <>
            <p style={{ marginTop: '1rem' }}>
              Sign a short message to prove this wallet is yours. It authorises no transfer and
              costs no fee.
            </p>
            <button className="primary" onClick={linkWallet} disabled={busy === 'link'}>
              {busy === 'link' ? 'Waiting for your wallet…' : 'Prove ownership'}
            </button>
          </>
        )}
        {account.wallet && !publicKey && (
          <p style={{ marginTop: '1rem' }} className="lede">
            {short(account.wallet)} is linked. Connect it again to sign anything.
          </p>
        )}
      </div>

      <h2>Waiting for you to sign</h2>
      {account.pendingApprovals.length === 0 ? (
        <p className="empty">
          Nothing pending. Reply to a post with “@{account.botHandle} send 0.1 sol to this user”.
        </p>
      ) : (
        account.pendingApprovals.map((p) => (
          <div className="row" key={p.id}>
            <span className="row-main">
              <strong>
                {p.amountSol} SOL to {p.to ? `@${p.to}` : 'an unregistered account'}
              </strong>
              <span className="row-sub">
                {p.route === 'escrow' ? 'Goes to escrow until they join' : 'Direct to their wallet'} ·
                expires {new Date(p.expiresAt).toLocaleTimeString()}
              </span>
            </span>
            <Link to={`/approve/${p.id}`}>
              <button className="quiet">Review</button>
            </Link>
          </div>
        ))
      )}

      {account.escrowEnabled && <h2>Tips waiting for you to claim</h2>}
      {!account.escrowEnabled ? null : account.claimable.length === 0 ? (
        <p className="empty">Nothing held for you right now.</p>
      ) : (
        account.claimable.map((c) => (
          <div className="row" key={c.escrow}>
            <span className="row-main">
              <strong className="held">{c.amountSol} SOL</strong>
              <span className="row-sub">
                from {c.from ? `@${c.from}` : 'someone'} · returns to them after{' '}
                {new Date(c.refundableAfter).toLocaleDateString()}
              </span>
            </span>
            <button
              className="quiet"
              onClick={() => claim(c.escrow)}
              disabled={!account.wallet || !publicKey || busy === c.escrow}
            >
              {busy === c.escrow ? 'Claiming…' : 'Claim'}
            </button>
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
              <strong>
                {s.amountSol} SOL to {s.to ? `@${s.to}` : 'an unregistered account'}
              </strong>
              <span className="row-sub">
                {new Date(s.at).toLocaleDateString()} ·{' '}
                {s.route === 'escrow' ? 'held in escrow' : 'delivered'}
              </span>
            </span>
            <span className="addr">{s.signature ? short(s.signature) : ''}</span>
          </div>
        ))
      )}

      <p className="custody">
        XCrypto never holds your SOL and has no key that can spend it. Every transfer leaves your
        wallet only after you sign it.{' '}
        <button
          className="quiet"
          style={{ padding: '0.125rem 0.5rem', fontSize: '0.8125rem' }}
          onClick={signOut}
        >
          Sign out
        </button>
      </p>
    </>
  );
}
