import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Connection, Transaction } from '@solana/web3.js';
import { useWallet, WalletButton, base64ToBytes } from '../wallet';
import { ApiError, buildIntentTx, confirmIntent, getAccount, getIntent, loginUrl, runtimeRpcUrl, type IntentView } from '../api';
import { evmSend, evmConfirm, evmConnect, currentEvmAddress } from '../evm';
import { Coin } from '../Coin';

let _conn: Connection | null = null;
function rpc(): Connection {
  const url = runtimeRpcUrl ?? import.meta.env.VITE_RPC_URL ?? 'https://api.devnet.solana.com';
  if (!_conn || _conn.rpcEndpoint !== url) _conn = new Connection(url, 'confirmed');
  return _conn;
}

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
      await getAccount(); // populates CSRF token
      const view = await getIntent(id);
      setIntent(view);
      if (view.signature) setSignature(view.signature);
    } catch (err) {
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
    if (!id) return;
    const isEvm = intent?.chain === 'robinhood';
    if (!isEvm && !signTransaction) return;
    setError(null);
    setSending(true);
    try {
      if (intent && intent.chain !== 'solana') {
        // EVM path: build + sign + broadcast client-side, then report the hash.
        if (!intent.recipientWallet) {
          throw new Error('Recipient has no wallet linked for this chain.');
        }
        const from = (await currentEvmAddress()) ?? (await evmConnect());
        // Exact base-unit amount from the server — no lossy decimal re-parsing.
        const amount = BigInt(intent.amountBase);
        const hash = await evmSend({
          from,
          to: intent.recipientWallet,
          amount,
          contract: intent.contract ?? undefined,
          chainKey: intent.chain,
        });
        await evmConfirm(hash);
        await confirmIntent(id, hash);
        setSignature(hash);
        await load();
        return;
      }

      // Solana path.
      const { base64 } = await buildIntentTx(id);
      const tx = Transaction.from(base64ToBytes(base64));
      const signed = await signTransaction(tx);
      const sig = await rpc().sendRawTransaction(signed.serialize());
      await rpc().confirmTransaction(sig, 'confirmed');
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
        <h1>Can't open this request</h1>
        <p className="error">{error}</p>
        <Link to="/dashboard" className="btn btn-ghost" style={{ display: 'inline-block' }}>
          Back to your account
        </Link>
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

      <div className="card">
        <div className="amount-row">
          <Coin symbol={intent.token} logo={intent.logo} size="lg" />
          <p className="amount">
            {intent.amount}
            <span className="unit">{intent.token}</span>
          </p>
        </div>

        <dl className="facts">
          <div>
            <dt>To</dt>
            <dd>{recipient}</dd>
          </div>
          {intent.recipientWallet && (
            <div>
              <dt>Their wallet</dt>
              <dd className="mono">{short(intent.recipientWallet)}</dd>
            </div>
          )}
          <div>
            <dt>From</dt>
            <dd className="mono">{publicKey ? short(publicKey.toBase58()) : 'Connect a wallet'}</dd>
          </div>
          {!done && (
            <div>
              <dt>Expires</dt>
              <dd>{new Date(intent.expiresAt).toLocaleTimeString()}</dd>
            </div>
          )}
          {signature && (
            <div>
              <dt>Signature</dt>
              <dd className="mono">
                <a
                  href={`https://solscan.io/tx/${signature}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {short(signature)}
                </a>
              </dd>
            </div>
          )}
        </dl>

        {error && <p className="error">{error}</p>}

        {done ? (
          <Link to="/dashboard">
            <button className="btn btn-primary">Back to your account</button>
          </Link>
        ) : dead ? (
          <>
            <p className="muted" style={{ marginTop: '1.25rem' }}>
              This request is {intent.status}. Post the reply again to create a new one.
            </p>
            <Link to="/dashboard">
              <button className="btn btn-ghost" style={{ width: '100%', marginTop: '0.5rem' }}>
                Back to your account
              </button>
            </Link>
          </>
        ) : !publicKey ? (
          <div style={{ marginTop: '1.25rem' }}>
            <WalletButton />
          </div>
        ) : (
          <button className="btn btn-primary" onClick={send} disabled={sending}>
            {sending ? 'Waiting for your wallet…' : `Send ${intent.amount} ${intent.token}`}
          </button>
        )}
      </div>
    </>
  );
}
