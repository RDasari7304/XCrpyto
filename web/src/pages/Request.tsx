import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Coin } from '../Coin';
import { toBase } from '../amounts';
import {
  ApiError,
  cancelRequest,
  createRequest,
  getAccount,
  getBalances,
  loginUrl,
  myRequests,
  shareOnX,
  type PaymentRequest,
  type TokenBalance,
} from '../api';

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function RequestPage() {
  const [ready, setReady] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);

  const [symbol, setSymbol] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PaymentRequest | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { requests } = await myRequests();
    setRequests(requests);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const account = await getAccount();
        setWallet(account.wallet);
        if (account.wallet) {
          // The balances endpoint lists every Solana token XLedger supports.
          const b = await getBalances().catch(() => null);
          if (b) {
            setTokens(b.tokens);
            if (!b.tokens.some((t) => t.symbol === 'USDC') && b.tokens[0]) setSymbol(b.tokens[0].symbol);
          }
        }
        await refresh();
        setReady(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = loginUrl('/request');
          return;
        }
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setReady(true);
      }
    })();
  }, [refresh]);

  const token = tokens.find((t) => t.symbol === symbol) ?? null;
  const base = token ? toBase(amount, token.decimals) : null;
  const amountProblem =
    token && amount.trim() !== '' && (base === null || base <= 0n)
      ? `Enter an amount above zero with at most ${token.decimals} decimal places.`
      : null;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      /* clipboard blocked; the link is visible to select manually */
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !base || base <= 0n) return;
    setBusy(true);
    setError(null);
    try {
      const { id } = await createRequest({ token: token.symbol, amount: amount.trim(), note: note.trim() });
      const { requests: fresh } = await myRequests();
      setRequests(fresh);
      setCreated(fresh.find((r) => r.id === id) ?? null);
      setAmount('');
      setNote('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that request');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    try {
      await cancelRequest(id);
      if (created?.id === id) setCreated(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that request');
    }
  };

  if (!ready) return <p className="lede">Loading…</p>;

  if (!wallet) {
    return (
      <>
        <h1>Request</h1>
        <p className="empty">
          Link a Solana wallet on your <Link to="/dashboard">account page</Link> first, so payments
          have somewhere to go.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Request</h1>
      <p className="lede">
        Make a “pay me” link for an exact amount. Anyone with the link can pay it from their own
        wallet, and it closes itself once paid.
      </p>

      {created && (
        <div className="card share-card" style={{ marginTop: '1.5rem' }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            Link ready: {created.amount} {created.token}
            {created.note ? ` for “${created.note}”` : ''}
          </p>
          <div className="link-row">
            <input className="input mono" readOnly value={created.link} onFocus={(e) => e.target.select()} />
            <button className="btn btn-ghost" type="button" onClick={() => void copy(created.link)}>
              {copied === created.link ? 'Copied' : 'Copy'}
            </button>
          </div>
          <a className="btn btn-primary share-x" href={shareOnX(created)} target="_blank" rel="noreferrer noopener">
            Share on X
          </a>
        </div>
      )}

      <form className="card" onSubmit={submit} style={{ marginTop: created ? '0.85rem' : '1.5rem' }}>
        <label className="field-label">Token</label>
        <div className="token-pick">
          {tokens.map((t) => (
            <button
              type="button"
              key={t.symbol}
              className={`token-opt${t.symbol === symbol ? ' on' : ''}`}
              onClick={() => setSymbol(t.symbol)}
            >
              <Coin symbol={t.symbol} logo={t.logo} />
              <span style={{ fontWeight: 600 }}>{t.symbol}</span>
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="req-amount">Amount</label>
        <input
          id="req-amount"
          className="input"
          inputMode="decimal"
          placeholder={`0.00 ${symbol}`}
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
        />
        {amountProblem && <p className="error">{amountProblem}</p>}

        <label className="field-label" htmlFor="req-note">What's it for? (optional)</label>
        <input
          id="req-note"
          className="input"
          maxLength={140}
          placeholder="Pizza on Friday"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        {error && <p className="error">{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={busy || !base || base <= 0n}>
          {busy ? 'Creating…' : 'Create payment link'}
        </button>
      </form>

      <h2>Your requests</h2>
      {requests.length === 0 ? (
        <p className="empty">No requests yet. Create one above and share the link.</p>
      ) : (
        requests.map((r) => (
          <div className="tx" key={r.id}>
            <Coin symbol={r.token} logo={r.logo} />
            <div className="tx-body">
              <div className="tx-line">
                <span className="tx-amt">{r.amount}</span>
                <span className="tx-sym">{r.token}</span>
                {r.note && <span className="tx-to">for “{r.note}”</span>}
              </div>
              <div className="tx-sub">
                {r.status === 'paid' ? (
                  <>
                    Paid by {r.paidBy ? `@${r.paidBy}` : 'someone'} · {when(r.paidAt ?? r.createdAt)}
                    {r.txUrl && (
                      <>
                        {' · '}
                        <a href={r.txUrl} target="_blank" rel="noreferrer noopener" className="tx-sig">
                          view transaction
                        </a>
                      </>
                    )}
                  </>
                ) : r.status === 'cancelled' ? (
                  <>Cancelled · created {when(r.createdAt)}</>
                ) : (
                  <>Waiting for payment · created {when(r.createdAt)}</>
                )}
              </div>
            </div>
            <div className="tx-right req-actions">
              {r.status === 'open' ? (
                <>
                  <button className="btn btn-ghost btn-sm" onClick={() => void copy(r.link)}>
                    {copied === r.link ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void cancel(r.id)}>
                    Cancel
                  </button>
                </>
              ) : (
                <span className={`pill${r.status === 'paid' ? ' pill-ok' : ''}`}>
                  {r.status === 'paid' ? 'Paid' : 'Cancelled'}
                </span>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}
