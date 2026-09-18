import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccount, loginUrl } from '../api';

export default function Landing() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    getAccount()
      .then(() => navigate('/dashboard', { replace: true }))
      .catch(() => setChecking(false));
  }, [navigate]);

  if (checking) return <p className="lede">Checking your session…</p>;

  return (
    <>
      <h1>Tip anyone on X in SOL</h1>
      <p className="lede">
        Reply to a post with <strong>@XCryptoBot send 0.1 sol to this user</strong>. We build the
        transaction; you sign it in your own wallet. If they haven&apos;t joined yet, the SOL waits
        in an escrow only they can open — and comes back to you if they never do.
      </p>

      <div className="slip">
        <h2 style={{ marginTop: 0 }}>Where your SOL sits</h2>
        <dl className="facts">
          <div>
            <dt>Before you sign</dt>
            <dd>Your wallet</dd>
          </div>
          <div>
            <dt>Sent to someone registered</dt>
            <dd>Straight to their wallet</dd>
          </div>
          <div>
            <dt>Sent to someone new</dt>
            <dd>On-chain escrow</dd>
          </div>
          <div>
            <dt>Ever held by XCrypto</dt>
            <dd>Never</dd>
          </div>
        </dl>
        <a href={loginUrl()}>
          <button className="primary">Sign in with X</button>
        </a>
      </div>

      <p className="custody">
        Signing in with X only tells us which account is yours. It grants no permission to post from
        your account or move your funds.
      </p>
    </>
  );
}
