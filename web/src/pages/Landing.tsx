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
      <h1>Send crypto to anyone on X</h1>
      <p className="lede">
        Reply to any post with a tip. We build the transaction — you sign it in your own wallet.
        We never hold your funds.
      </p>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <p className="muted" style={{ marginBottom: '0.5rem' }}>Try it like this</p>
        <p className="tokens" style={{ fontSize: '1.05rem', margin: 0 }}>
          @XCryptoBott send <b>5 usdc</b> to @friend
        </p>
      </div>

      <div className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <p><strong>Sign in with X.</strong> Connect a Solana wallet and prove it's yours. Takes a minute.</p>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <p><strong>Mention the bot.</strong> Reply to any post naming an amount and who gets it.</p>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <p><strong>Sign and send.</strong> We send you a link — you approve the exact transfer in your wallet.</p>
        </div>
      </div>

      <div className="card center" style={{ marginTop: '0.5rem' }}>
        <p className="muted" style={{ marginTop: 0 }}>Supported today</p>
        <p className="tokens" style={{ fontSize: '1.1rem', margin: '0 0 1.25rem' }}>
          <b>SOL</b> · <b>USDC</b> · <b>CATE</b> · <b>ZCAT</b> · <b>ANSEM</b>
        </p>
        <a href={loginUrl()}>
          <button className="btn btn-primary">Sign in with X</button>
        </a>
      </div>

      <p className="muted center" style={{ marginTop: '1.5rem' }}>
        Signing in tells us which account is yours. It grants no permission to post from your
        account or move your funds.
      </p>
    </>
  );
}
