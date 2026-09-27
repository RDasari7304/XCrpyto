import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Connection, Transaction } from '@solana/web3.js';
import { useWallet, WalletButton, base64ToBytes } from '../wallet';
import {
  ApiError,
  buildIntentTx,
  confirmIntent,
  getAccount,
  getIntent,
  getPreflight,
  loginUrl,
  runtimeRpcUrl,
  type IntentView,
  type Preflight,
} from '../api';
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

/** Turn wallet/RPC errors into something a person can act on. */
function friendlyError(err: unknown, token: string): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/user rejected|rejected the request|declined|cancell?ed/i.test(msg)) return 'You cancelled in your wallet. Nothing was sent.';
  if (/insufficient lamports|no record of a prior credit|insufficient funds for fee/i.test(msg))
    return 'Not enough SOL in this wallet for this transfer and its fee. Nothing was sent.';
  if (/insufficient funds/i.test(msg)) return `Not enough ${token} in this wallet. Nothing was sent.`;
  if (/blockhash not found|block height exceeded/i.test(msg))
    return 'That took too long and the network rejected it. Nothing was sent. Press Send to try again.';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Could not reach the network. Check your connection and try again.';
  // Simulation errors carry pages of logs; keep the first sentence.
  return msg.split(/\. (?:Logs|Catch)/)[0].slice(0, 220) || 'The transfer did not go through.';
}

function countdown(ms: number): string {
  if (ms <= 0) return 'expired';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}

export default function Approve() {
  const { id } = useParams<{ id: string }>();
  const { publicKey, signTransaction } = useWallet();
  const [intent, setIntent] = useState<IntentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkedWallet, setLinkedWallet] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const account = await getAccount(); // also populates the CSRF token
      setLinkedWallet(account.wallet);
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

  // Live expiry countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Check balances against the chain before asking for a signature.
  const runPreflight = useCallback(async () => {
    if (!id) return;
    setChecking(true);
    try {
      setPreflight(await getPreflight(id));
    } catch {
      setPreflight(null); // the check is advisory; never block on it failing
    } finally {
      setChecking(false);
    }
  }, [id]);

  const needsPreflight =
    intent?.chain === 'solana' && intent.status === 'awaiting_approval' && signature === null;
  useEffect(() => {
    if (needsPreflight && linkedWallet) void runPreflight();
  }, [needsPreflight, linkedWallet, runPreflight]);

  const send = async () => {
    if (!id) return;
    const isEvm = Boolean(intent && intent.chain !== 'solana');
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
      // The transfer is on its way from this point. Lock the page now so a
      // later failure (slow confirmation, server bookkeeping) can never lead
      // to a second, duplicate send.
      setSignature(sig);
      try {
        await rpc().confirmTransaction(sig, 'confirmed');
        await confirmIntent(id, sig);
        await load();
      } catch {
        setNotice(
          'Your transfer was submitted. It can take a few seconds to show up. Check the signature link below; do not send it again.',
        );
      }
    } catch (err) {
      setError(friendlyError(err, intent?.token ?? 'tokens'));
      if (intent?.chain === 'solana') void runPreflight();
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
  const msLeft = new Date(intent.expiresAt).getTime() - now;
  const dead = ['expired', 'cancelled'].includes(intent.status) || (!done && msLeft <= 0);
  const txUrl = (sig: string) =>
    intent.explorerTx ? intent.explorerTx.replace('{sig}', sig) : `https://solscan.io/tx/${sig}`;
  // Phantom connected to a different account than the one linked to XLedger:
  // the server builds the transaction for the linked wallet, so it would fail.
  const wrongWallet =
    intent.chain === 'solana' && publicKey && linkedWallet && publicKey.toBase58() !== linkedWallet;
  const blocked = Boolean(wrongWallet || (preflight && !preflight.ok));

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
              <dd className={msLeft < 5 * 60_000 ? 'warn-text' : undefined}>
                {new Date(intent.expiresAt).toLocaleTimeString()} · {countdown(msLeft)}
              </dd>
            </div>
          )}
          {signature && (
            <div>
              <dt>Signature</dt>
              <dd className="mono">
                <a
                  href={txUrl(signature)}
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
        {notice && <p className="muted" style={{ marginTop: '1rem' }}>{notice}</p>}

        {!done && !dead && wrongWallet && (
          <div className="warn">
            <strong>Wrong wallet connected.</strong> Your wallet app is on {short(publicKey!.toBase58())},
            but your XLedger account is linked to {short(linkedWallet!)}. Switch accounts in your wallet
            app, or link this one from your <Link to="/dashboard">account page</Link>.
          </div>
        )}

        {!done && !dead && preflight && !preflight.ok && (
          <div className="warn">
            <strong>This transfer would fail right now.</strong>
            <ul>
              {preflight.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <button className="btn btn-ghost btn-sm" onClick={() => void runPreflight()} disabled={checking}>
              {checking ? 'Checking…' : 'I added funds, check again'}
            </button>
          </div>
        )}

        {!done && !dead && preflight?.ok && (
          <p className="ok-text">
            ✓ Balance checked: {preflight.sol} SOL
            {preflight.token !== null && ` · ${preflight.token} ${intent.token}`}
            {preflight.setupSol && ` · includes ~${preflight.setupSol} SOL to open their ${intent.token} account`}
          </p>
        )}

        {done ? (
          <Link to="/dashboard">
            <button className="btn btn-primary">Back to your account</button>
          </Link>
        ) : dead ? (
          <>
            <p className="muted" style={{ marginTop: '1.25rem' }}>
              This request {intent.status === 'cancelled' ? 'was cancelled' : 'expired'}. Post the reply
              again, or use the <Link to="/send">Send</Link> tab, to create a new one.
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
          <button className="btn btn-primary" onClick={send} disabled={sending || blocked}>
            {sending
              ? 'Waiting for your wallet…'
              : checking && !preflight
                ? 'Checking your balance…'
                : `Send ${intent.amount} ${intent.token}`}
          </button>
        )}
      </div>
    </>
  );
}
