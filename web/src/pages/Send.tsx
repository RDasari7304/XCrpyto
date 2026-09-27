import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../Avatar';
import { Coin } from '../Coin';
import { fromBase, toBase } from '../amounts';
import {
  ApiError,
  createTransfer,
  getAccount,
  getBalances,
  loginUrl,
  searchUsers,
  type Recipient,
  type TokenBalance,
} from '../api';

// SOL kept back when using "Max" so the wallet can still pay network fees.
const SOL_RESERVE = 1_000_000n; // 0.001 SOL
// Rough cost of creating the recipient's token account for an SPL token they
// have never held (paid by the sender), plus the fee.
const SPL_SOL_NEEDED = 2_100_000n; // ~0.0021 SOL

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function Send() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [ready, setReady] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [lamports, setLamports] = useState<bigint>(0n);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const [query, setQuery] = useState(params.get('to') ?? '');
  const [results, setResults] = useState<Recipient[]>([]);
  const [searching, setSearching] = useState(false);
  const [recipient, setRecipient] = useState<Recipient | null>(null);

  const [symbol, setSymbol] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoPick = useRef(Boolean(params.get('to')));

  // Session + balances.
  useEffect(() => {
    (async () => {
      try {
        const account = await getAccount();
        setWallet(account.wallet);
        if (account.wallet) {
          try {
            const b = await getBalances();
            const held = b.tokens.filter((t) => BigInt(t.balance) > 0n);
            setTokens(held);
            setLamports(BigInt(b.lamports ?? '0'));
            if (held.length > 0) setSymbol(held[0].symbol);
          } catch (err) {
            setBalanceError(err instanceof Error ? err.message : 'Could not read your balances');
          }
        }
        setReady(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          window.location.href = loginUrl(`/send${window.location.search}`);
          return;
        }
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setReady(true);
      }
    })();
  }, []);

  // Debounced handle search.
  useEffect(() => {
    if (recipient) return;
    const q = query.trim().replace(/^@/, '');
    if (!/^\w{1,15}$/.test(q)) {
      setResults([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const { users } = await searchUsers(q);
        setResults(users);
        // Arriving from Members with ?to=handle: select an exact match.
        if (autoPick.current) {
          autoPick.current = false;
          const exact = users.find((u) => u.handle.toLowerCase() === q.toLowerCase());
          if (exact) setRecipient(exact);
        }
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, recipient]);

  const token = useMemo(() => tokens.find((t) => t.symbol === symbol) ?? null, [tokens, symbol]);
  const balance = token ? BigInt(token.balance) : 0n;
  const base = token ? toBase(amount, token.decimals) : null;

  const amountProblem = (() => {
    if (!token || amount.trim() === '') return null;
    if (base === null) return `Enter a number with at most ${token.decimals} decimal places.`;
    if (base <= 0n) return 'Amount must be greater than zero.';
    if (base > balance) return `You only have ${token.display} ${token.symbol}.`;
    if (token.symbol === 'SOL' && balance - base < 5_000n) return 'Leave a little SOL for the network fee.';
    return null;
  })();

  const lowSolForSpl = token && token.symbol !== 'SOL' && lamports < SPL_SOL_NEEDED;

  const setMax = () => {
    if (!token) return;
    const max = token.symbol === 'SOL' ? (balance > SOL_RESERVE ? balance - SOL_RESERVE : 0n) : balance;
    setAmount(fromBase(max, token.decimals));
  };

  const canSubmit = Boolean(recipient && token && base && base > 0n && !amountProblem && !submitting);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!recipient || !token || !canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const { id } = await createTransfer({ toUserId: recipient.id, token: token.symbol, amount: amount.trim() });
      navigate(`/approve/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that transfer');
      setSubmitting(false);
    }
  };

  if (!ready) return <p className="lede">Loading…</p>;

  if (!wallet) {
    return (
      <>
        <h1>Send</h1>
        <p className="empty">
          Link a Solana wallet on your <Link to="/dashboard">account page</Link> first, then come back
          here to send.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Send</h1>
      <p className="lede">Pick someone on XLedger, choose a token from your wallet, and sign it.</p>

      <form className="card" onSubmit={submit} style={{ marginTop: '1.5rem' }}>
        {/* 1. Recipient */}
        <label className="field-label" htmlFor="to">To</label>
        {recipient ? (
          <div className="picked">
            <Avatar handle={recipient.handle} src={recipient.avatar} size={40} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>@{recipient.handle}</div>
              <div className="muted mono" style={{ fontSize: '0.82rem' }}>{short(recipient.wallet)}</div>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setRecipient(null);
                setResults([]);
              }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="to"
              className="input"
              placeholder="Search by X handle"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <div className="results">
                {results.map((u) => (
                  <button type="button" key={u.id} className="result" onClick={() => setRecipient(u)}>
                    <Avatar handle={u.handle} src={u.avatar} size={32} />
                    <span style={{ fontWeight: 600 }}>@{u.handle}</span>
                    <span className="muted mono" style={{ marginLeft: 'auto', fontSize: '0.8rem' }}>
                      {short(u.wallet)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!searching && query.trim().replace(/^@/, '').length > 0 && results.length === 0 && (
              <p className="muted" style={{ margin: '0.6rem 0 0' }}>
                No one by that handle has linked a wallet on XLedger yet.
              </p>
            )}
          </>
        )}

        {/* 2. Token */}
        <label className="field-label" htmlFor="token">Token</label>
        {balanceError ? (
          <p className="error" style={{ marginTop: 0 }}>{balanceError}</p>
        ) : tokens.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Your linked wallet ({short(wallet)}) holds none of the tokens XLedger supports.
          </p>
        ) : (
          <div className="token-pick">
            {tokens.map((t) => (
              <button
                type="button"
                key={t.symbol}
                className={`token-opt${t.symbol === symbol ? ' on' : ''}`}
                onClick={() => {
                  setSymbol(t.symbol);
                  setAmount('');
                }}
              >
                <Coin symbol={t.symbol} logo={t.logo} />
                <span style={{ textAlign: 'left' }}>
                  <span style={{ display: 'block', fontWeight: 600 }}>{t.symbol}</span>
                  <span className="muted" style={{ fontSize: '0.8rem' }}>{t.display}</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {/* 3. Amount */}
        {token && (
          <>
            <label className="field-label" htmlFor="amount">Amount</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="amount"
                className="input"
                inputMode="decimal"
                placeholder={`0.00 ${token.symbol}`}
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
              />
              <button type="button" className="btn btn-ghost" onClick={setMax}>
                Max
              </button>
            </div>
            <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.82rem' }}>
              Balance: {token.display} {token.symbol}
              {token.transferFeeBps > 0 &&
                ` · ${token.symbol} takes a ${token.transferFeeBps / 100}% fee on every transfer, so they receive slightly less`}
            </p>
            {amountProblem && <p className="error">{amountProblem}</p>}
            {lowSolForSpl && (
              <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.82rem' }}>
                Heads up: you have {fromBase(lamports, 9)} SOL. Sending {token.symbol} to someone who has
                never held it costs about 0.002 SOL to set up their account.
              </p>
            )}
          </>
        )}

        {error && <p className="error">{error}</p>}

        <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
          {submitting
            ? 'Preparing…'
            : recipient && token && base && !amountProblem
              ? `Review ${amount.trim()} ${token.symbol} to @${recipient.handle}`
              : 'Review transfer'}
        </button>
        <p className="muted center" style={{ margin: '0.75rem 0 0', fontSize: '0.82rem' }}>
          Nothing moves until you approve it in your wallet on the next screen.
        </p>
      </form>
    </>
  );
}
