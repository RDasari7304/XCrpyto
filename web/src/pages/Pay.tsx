import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../Avatar';
import { Coin } from '../Coin';
import { ActionPanel } from '../ActionPanel';
import { ApiError, getAccount, getRequest, loginUrl, payRequest, type PaymentRequest } from '../api';

/**
 * Public landing page for a "pay me" link. Anyone can see what is being asked
 * for; paying needs sign-in and a linked wallet, then continues on the normal
 * approval page where the payer signs the exact transfer.
 */
export default function Pay() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [req, setReq] = useState<PaymentRequest | null>(null);
  const [me, setMe] = useState<{ handle: string | null; wallet: string | null } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setReq(await getRequest(id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load this request');
      }
      try {
        const account = await getAccount(); // also sets the CSRF token
        setMe({ handle: account.handle, wallet: account.wallet });
        setSignedIn(true);
      } catch {
        setSignedIn(false); // viewing signed-out is fine
      }
    })();
  }, [id]);

  const pay = async () => {
    if (!id) return;
    if (!signedIn) {
      window.location.href = loginUrl(`/pay/${id}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { intentId } = await payRequest(id);
      navigate(`/approve/${intentId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        window.location.href = loginUrl(`/pay/${id}`);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not start that payment');
      setBusy(false);
    }
  };

  if (error && !req) {
    return (
      <>
        <h1>Request not found</h1>
        <p className="error">{error}</p>
        <Link to="/">Go to XLedger</Link>
      </>
    );
  }
  if (!req) return <p className="lede">Loading…</p>;

  const own = signedIn && me?.handle && req.requester && me.handle.toLowerCase() === req.requester.toLowerCase();

  return (
    <>
      <div className="payer-head">
        {req.requester && <Avatar handle={req.requester} src={req.requesterAvatar} size={52} />}
        <div>
          <h1 style={{ margin: 0 }}>@{req.requester} is requesting</h1>
          {req.note && <p className="lede" style={{ margin: '0.2rem 0 0' }}>“{req.note}”</p>}
        </div>
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <div className="amount-row">
          <Coin symbol={req.token} logo={req.logo} size="lg" />
          <p className="amount">
            {req.amount}
            <span className="unit">{req.token}</span>
          </p>
        </div>

        {error && <p className="error">{error}</p>}

        {req.status === 'paid' ? (
          <p className="ok-text" style={{ fontSize: '0.95rem' }}>
            ✓ Paid{req.paidBy ? ` by @${req.paidBy}` : req.paidByWallet ? ` by ${req.paidByWallet}` : ''}.
            {req.txUrl && (
              <>
                {' '}
                <a href={req.txUrl} target="_blank" rel="noreferrer noopener" style={{ textDecoration: 'underline' }}>
                  View transaction
                </a>
              </>
            )}
          </p>
        ) : req.status === 'cancelled' ? (
          <p className="muted" style={{ marginTop: '1.25rem' }}>@{req.requester} cancelled this request.</p>
        ) : own ? (
          <p className="muted" style={{ marginTop: '1.25rem' }}>
            This is your request. Share this page's link with whoever is paying. Track it on the{' '}
            <Link to="/request">Request</Link> tab.
          </p>
        ) : req.payable === false ? (
          <p className="muted" style={{ marginTop: '1.25rem' }}>
            @{req.requester} has no wallet linked right now, so this can't be paid yet.
          </p>
        ) : signedIn && !me?.wallet ? (
          <p className="muted" style={{ marginTop: '1.25rem' }}>
            Link a Solana wallet on your <Link to="/dashboard">account page</Link>, then come back to
            this link to pay.
          </p>
        ) : (
          <>
            <button className="btn btn-primary" onClick={() => void pay()} disabled={busy}>
              {busy ? 'Preparing…' : signedIn ? `Pay ${req.amount} ${req.token}` : 'Sign in with X to pay'}
            </button>
            <p className="muted center" style={{ margin: '0.75rem 0 0', fontSize: '0.82rem' }}>
              You'll review and sign the exact transfer in your own wallet. XLedger never holds funds.
            </p>
            {!signedIn && (
              <>
                <div className="or-divider"><span>or pay with any Solana wallet, no account</span></div>
                <ActionPanel path={`/api/actions/pay/${id}`} compact />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
