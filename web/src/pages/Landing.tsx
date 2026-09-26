import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAccount, loginUrl } from '../api';
import { Coin } from '../Coin';

const SOL_LOGO = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png';
const USDC_LOGO = 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png';

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
      <div className="grid grid-2">
        <div>
          <h1>Send crypto to anyone on X</h1>
          <p className="lede">
            Reply to any post with a tip. We build the transaction — you sign it in your own wallet.
            We never hold your funds.
          </p>
          <div className="card" style={{ marginTop: '1.5rem' }}>
            <p className="muted" style={{ marginBottom: '0.6rem' }}>Try it like this</p>
            <div className="example">
              <Coin symbol="USDC" logo={USDC_LOGO} />
              <span>@XLedger_Bot send <b>5 usdc</b> to @friend</span>
            </div>
          </div>
        </div>

        <div className="card center">
          <p className="muted" style={{ marginTop: 0 }}>Supported today</p>
          <div className="token-chips" style={{ margin: '0 0 1.25rem' }}>
            <Coin symbol="SOL" logo={SOL_LOGO} />
            <Coin symbol="USDC" logo={USDC_LOGO} />
            <Coin symbol="CATE" />
            <Coin symbol="ZCAT" />
            <Coin symbol="ANSEM" />
          </div>
          <a href={loginUrl()}>
            <button className="btn btn-primary">Sign in with X</button>
          </a>
          <p className="muted" style={{ margin: '1rem 0 0', fontSize: '0.8rem' }}>
            Grants no permission to post or move funds.
          </p>
        </div>
      </div>

      <h2>How it works</h2>
      <div className="steps">
        <div className="step">
          <div className="step-n">1</div>
          <p><strong>Sign in with X.</strong> Connect a Solana wallet and prove it's yours. Takes a minute.</p>
        </div>
        <div className="step">
          <div className="step-n">2</div>
          <p><strong>Mention the bot.</strong> Reply to any post naming an amount and who gets it.</p>
        </div>
        <div className="step">
          <div className="step-n">3</div>
          <p><strong>Sign and send.</strong> We send you a link — you approve the exact transfer in your wallet.</p>
        </div>
      </div>
    </>
  );
}
