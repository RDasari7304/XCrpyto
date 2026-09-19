import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import bs58 from 'bs58';
import { useWallet, WalletButton } from '../wallet';
import { Coin } from '../Coin';
import { useEvmVerify, ROBINHOOD_CHAIN, evmSend, evmConfirm, evmErc20Balance, currentEvmAddress, evmConnect, evmPersonalSign } from '../evm';
import {
  getAccount,
  logout,
  walletChallenge,
  walletVerify,
  walletVerifyEvm,
  type Account,
} from '../api';

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { publicKey, signMessage, disconnect } = useWallet();
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evm = useEvmVerify();
  const [aiTo, setAiTo] = useState('');
  const [aiAmt, setAiAmt] = useState('');
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [evmLinkBusy, setEvmLinkBusy] = useState(false);
  const [evmLinkMsg, setEvmLinkMsg] = useState<string | null>(null);

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

  const linkEvmWallet = async () => {
    setEvmLinkMsg(null);
    setEvmLinkBusy(true);
    try {
      const address = await evmConnect();
      const { message, nonce } = await walletChallenge();
      const signature = await evmPersonalSign(message, address);
      await walletVerifyEvm({ address, message, signature, nonce });
      await refresh();
      setEvmLinkMsg('✓ Robinhood Chain wallet linked');
    } catch (err: any) {
      setEvmLinkMsg(err?.message ?? 'Could not link EVM wallet');
    } finally {
      setEvmLinkBusy(false);
    }
  };

  const linkWallet = async () => {
    if (!publicKey || !signMessage) return;
    setError(null);
    setBusy(true);
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
      setBusy(false);
    }
  };

  const signOut = async () => {
    await logout();
    await disconnect().catch(() => {});
    navigate('/', { replace: true });
  };

  const AI_CONTRACT = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18';
  const AI_DECIMALS = 18;

  const sendAiTest = async () => {
    setAiStatus(null);
    if (!/^0x[a-fA-F0-9]{40}$/.test(aiTo.trim())) {
      setAiStatus('Enter a valid 0x… recipient address');
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(aiAmt.trim()) || Number(aiAmt) <= 0) {
      setAiStatus('Enter a positive amount');
      return;
    }
    setAiBusy(true);
    try {
      const from = await currentEvmAddress();
      if (!from) throw new Error('Connect your EVM wallet first (run Verify above)');

      // Decimal string -> base units (18 decimals), no float.
      const [wholeStr, fracStr = ''] = aiAmt.trim().split('.');
      const base = 10n ** BigInt(AI_DECIMALS);
      const amount =
        BigInt(wholeStr || '0') * base + BigInt((fracStr + '0'.repeat(AI_DECIMALS)).slice(0, AI_DECIMALS));

      const balance = await evmErc20Balance(AI_CONTRACT, from);
      if (balance < amount) {
        throw new Error(`Not enough AI. You hold ${balance} base units, need ${amount}.`);
      }

      setAiStatus('Waiting for your signature…');
      // Same evmSend the mention→approve flow will call.
      const hash = await evmSend({ from, to: aiTo.trim(), amount, contract: AI_CONTRACT });
      setAiStatus(`Submitted ${hash.slice(0, 10)}… — confirming…`);
      await evmConfirm(hash);
      setAiStatus(`✓ Confirmed. ${ROBINHOOD_CHAIN.explorer}/tx/${hash}`);
    } catch (err: any) {
      setAiStatus(err?.message ?? 'Send failed');
    } finally {
      setAiBusy(false);
    }
  };

  if (!account) return <p className="lede">Loading…</p>;

  const connectedButUnlinked = publicKey && account.wallet !== publicKey.toBase58();
  const initials = (account.handle ?? '?').slice(0, 2).toUpperCase();

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <h1>@{account.handle}</h1>
          <p className="lede" style={{ marginBottom: 0 }}>
            {account.wallet
              ? `Tips settle to ${short(account.wallet)}.`
              : 'Connect a wallet to start sending and receiving.'}
          </p>
        </div>
        <div className="profile">
          <span className="who">@{account.handle}</span>
          <span className="avatar">{initials}</span>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <div className="grid grid-2" style={{ marginTop: '1.5rem' }}>
        {/* Left column: transactions */}
        <div>
          <h2 style={{ marginTop: 0 }}>Waiting for you to sign</h2>
          {account.pendingApprovals.length === 0 ? (
            <p className="empty">
              Nothing pending. Reply to a post with “@{account.botHandle} send 5 usdc to this user”.
            </p>
          ) : (
            account.pendingApprovals.map((p) => (
              <div className="tx" key={p.id}>
                <Coin symbol={p.token} logo={p.logo} />
                <div className="tx-body">
                  <div className="tx-line">
                    <span className="tx-amt">{p.amount}</span>
                    <span className="tx-sym">{p.token}</span>
                    <span className="tx-to">to {p.to ? `@${p.to}` : 'an unregistered account'}</span>
                  </div>
                  <div className="tx-sub">expires {new Date(p.expiresAt).toLocaleTimeString()}</div>
                </div>
                <div className="tx-right">
                  <Link to={`/approve/${p.id}`}>
                    <button className="btn btn-primary btn-sm" style={{ width: 'auto', margin: 0 }}>
                      Review
                    </button>
                  </Link>
                </div>
              </div>
            ))
          )}

          <h2>Sent</h2>
          {account.sent.length === 0 ? (
            <p className="empty">No tips sent yet.</p>
          ) : (
            account.sent.map((s, i) => (
              <div className="tx" key={i}>
                <Coin symbol={s.token} logo={s.logo} />
                <div className="tx-body">
                  <div className="tx-line">
                    <span className="tx-amt">{s.amount}</span>
                    <span className="tx-sym">{s.token}</span>
                    <span className="tx-to">to {s.to ? `@${s.to}` : 'an unregistered account'}</span>
                  </div>
                  <div className="tx-sub">{new Date(s.at).toLocaleDateString()} · delivered</div>
                </div>
                {s.signature && (
                  <div className="tx-right">
                    <a
                      href={`https://solscan.io/tx/${s.signature}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="tx-sig mono"
                    >
                      {short(s.signature)}
                    </a>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Right column: wallet */}
        <div>
          <h2 style={{ marginTop: 0 }}>Wallet</h2>
          <div className="card">
            <WalletButton />
            {connectedButUnlinked && (
              <>
                <p className="muted" style={{ margin: '1rem 0 0.75rem' }}>
                  Sign a short message to prove this wallet is yours. It authorizes no transfer and
                  costs no fee.
                </p>
                <button className="btn btn-primary" onClick={linkWallet} disabled={busy}>
                  {busy ? 'Waiting for your wallet…' : 'Prove ownership'}
                </button>
              </>
            )}
            {account.wallet && !publicKey && (
              <p className="muted" style={{ marginTop: '1rem' }}>
                {short(account.wallet)} is linked. Connect it again to sign anything.
              </p>
            )}
          </div>

          <h2>Robinhood Chain wallet</h2>
          <div className="card">
            {account.evmWallet ? (
              <p className="muted" style={{ margin: 0 }}>
                Linked: <span className="mono">{account.evmWallet.slice(0, 6)}…{account.evmWallet.slice(-4)}</span>
                <br />AI tips sent to you route here.
              </p>
            ) : (
              <>
                <p className="muted" style={{ marginTop: 0 }}>
                  Link an EVM address to send and receive AI on Robinhood Chain. A Solana wallet
                  can't hold AI, so this is a separate address (Phantom's Ethereum mode).
                </p>
                <button className="btn btn-primary" onClick={() => void linkEvmWallet()} disabled={evmLinkBusy}>
                  {evmLinkBusy ? 'Waiting for your wallet…' : 'Link Robinhood Chain wallet'}
                </button>
              </>
            )}
            {evmLinkMsg && (
              <p className={evmLinkMsg.startsWith('✓') ? 'muted' : 'error'} style={{ marginTop: '0.85rem' }}>
                {evmLinkMsg}
              </p>
            )}
          </div>
        </div>
      </div>

      <h2>Robinhood Chain (verification)</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Read-only check — connects Phantom to {ROBINHOOD_CHAIN.name} (chain{' '}
          {ROBINHOOD_CHAIN.chainIdDec}) and reads the AI token's on-chain decimals and your
          native gas balance. Moves no funds.
        </p>
        <button className="btn btn-ghost" onClick={() => void evm.run()} disabled={evm.busy}>
          {evm.busy ? 'Checking…' : 'Verify Robinhood Chain'}
        </button>
        {evm.error && <p className="error">{evm.error}</p>}
        {evm.result && (
          <dl className="facts">
            <div>
              <dt>EVM address</dt>
              <dd className="mono">{evm.result.address}</dd>
            </div>
            <div>
              <dt>Chain id seen</dt>
              <dd>
                {evm.result.chainIdSeen}{' '}
                {evm.result.chainIdSeen === ROBINHOOD_CHAIN.chainIdDec ? '✓' : '✗ (wrong chain!)'}
              </dd>
            </div>
            <div>
              <dt>AI decimals on chain</dt>
              <dd>
                {evm.result.aiDecimalsOnChain}{' '}
                {evm.result.aiDecimalsOnChain === 18 ? '✓ matches 18' : '✗ NOT 18 — do not send yet'}
              </dd>
            </div>
            <div>
              <dt>Native gas balance (wei)</dt>
              <dd className="mono">{evm.result.nativeBalanceWei}</dd>
            </div>
          </dl>
        )}
      </div>

      <h2>Send AI (test)</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Sends real AI on Robinhood Chain to any address, using the exact transfer code the
          mention flow will use. Run “Verify” above first so your EVM wallet is connected. Needs a
          little ETH in your EVM wallet for gas.
        </p>
        <input
          className="input"
          placeholder="Recipient 0x… address"
          value={aiTo}
          onChange={(e) => setAiTo(e.target.value)}
          spellCheck={false}
        />
        <input
          className="input"
          placeholder="Amount of AI"
          value={aiAmt}
          onChange={(e) => setAiAmt(e.target.value)}
          inputMode="decimal"
          style={{ marginTop: '0.5rem' }}
        />
        <button className="btn btn-primary" onClick={() => void sendAiTest()} disabled={aiBusy}>
          {aiBusy ? 'Working…' : 'Send AI'}
        </button>
        {aiStatus && (
          <p className={aiStatus.startsWith('✓') ? 'muted' : aiStatus.startsWith('Waiting') || aiStatus.startsWith('Submitted') ? 'muted' : 'error'} style={{ marginTop: '0.85rem', overflowWrap: 'anywhere' }}>
            {aiStatus}
          </p>
        )}
      </div>

      <div className="foot">
        <span>XCrypto never holds your funds and can't spend them.</span>
        <button className="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </div>
    </>
  );
}
