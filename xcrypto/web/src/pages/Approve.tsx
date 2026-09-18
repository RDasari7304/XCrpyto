import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Connection, Transaction } from '@solana/web3.js';
import { useWallet, WalletButton, base64ToBytes } from '../wallet';
import { ApiError, buildIntentTx, confirmIntent, getAccount, getIntent, loginUrl, type IntentView } from '../api';

// A single shared RPC connection, replacing useConnection() from the adapter.
const connection = new Connection(
  import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8899',
  'confirmed',
);

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

export default function Approve() {
  const { id } = useParams<{ id: string }>();
  const { publicKey, signTransaction } = useWallet();
  const [intent, setIntent] = useState<IntentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      // Fetch the account first: this is what populates the CSRF token that
      // the approve/confirm POSTs require. The dashboard does this implicitly;
      // this page is often opened directly from an X link, so it must too.
      await getAccount();
      const view = await getIntent(id);
      setIntent(view);
      if (view.signature) setSignature(view.signature);
    } catch (err) {
      // Links arrive from X, so the visitor frequently has no session yet.
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = loginUrl(`/approve/${id}`);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load this tip request');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!id || !signTransaction) return;
    setError(null);
    setSending(true);
    try {
      // The server builds the transaction from its own record of the tip, so
      // nothing on this page can change who gets paid.
      const { base64 } = await buildIntentTx(id);
      const tx = Transaction.from(base64ToBytes(base64));
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, 'confirmed');
      await confirmIntent(id, sig);
      setSignature(sig);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The transfer did not go through');
    } finally {
      setSending(false);
    }
  };

  if (error && !intent) {
    return (
      <>
        <h1>Can&apos;t open this request</h1>
        <p className="error">{error}</p>
        <Link to="/dashboard">Back to your account</Link>
      </>
    );
  }
  if (!intent) return <p className="lede">Loading…</p>;

  const recipient = intent.to ? `@${intent.to}` : 'an account with no wallet yet';
  const done = signature !== null || intent.status === 'confirmed';
  const dead = ['expired', 'cancelled'].includes(intent.status);

  return (
    <>
      <h1>{done ? 'Sent' : 'Confirm this transfer'}</h1>

      <div className="slip">
        <p className="amount">
          {intent.amountSol}
          <span className="unit">SOL</span>
        </p>

        <dl className="facts">
          <div>
            <dt>To</dt>
            <dd>{recipient}</dd>
          </div>
          {intent.route === 'direct' && intent.recipientWallet && (
            <div>
              <dt>Their wallet</dt>
              <dd className="addr">{short(intent.recipientWallet)}</dd>
            </div>
          )}
          {intent.route === 'escrow' && (
            <div>
              <dt>Held in</dt>
              <dd>An escrow only they can open</dd>
            </div>
          )}
          <div>
            <dt>From</dt>
            <dd className="addr">{publicKey ? short(publicKey.toBase58()) : 'Connect a wallet'}</dd>
          </div>
          {!done && (
            <div>
              <dt>Request expires</dt>
              <dd>{new Date(intent.expiresAt).toLocaleTimeString()}</dd>
            </div>
          )}
          {signature && (
            <div>
              <dt>Signature</dt>
              <dd className="addr">{short(signature)}</dd>
            </div>
          )}
        </dl>

        {error && <p className="error">{error}</p>}

        {done ? (
          <Link to="/dashboard">
            <button className="primary">Back to your account</button>
          </Link>
        ) : dead ? (
          <>
            <p style={{ marginTop: '1.25rem' }}>
              This request is {intent.status}. Post the reply again to create a new one.
            </p>
            <Link to="/dashboard">
              <button className="quiet">Back to your account</button>
            </Link>
          </>
        ) : !publicKey ? (
          <div style={{ marginTop: '1.25rem' }}>
            <WalletButton />
          </div>
        ) : (
          <button className="primary" onClick={send} disabled={sending}>
            {sending ? 'Waiting for your wallet…' : `Send ${intent.amountSol} SOL`}
          </button>
        )}
      </div>

      {intent.route === 'escrow' && !done && (
        <p className="custody">
          {recipient} hasn&apos;t connected a wallet, so this goes into an on-chain escrow. Only
          they can claim it, and you can take it back after 30 days if they don&apos;t.
        </p>
      )}
    </>
  );
}
