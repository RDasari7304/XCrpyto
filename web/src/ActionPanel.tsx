import { useEffect, useState } from 'react';
import { Connection, Transaction } from '@solana/web3.js';
import { useWallet, WalletButton, base64ToBytes } from './wallet';
import {
  confirmAction,
  getAction,
  getPublicConfig,
  postAction,
  type ActionLink,
  type ActionMeta,
} from './api';

function fill(href: string, values: Record<string, string>): string {
  return href.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(values[k] ?? ''));
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/user rejected|rejected the request|declined|cancell?ed/i.test(msg)) return 'You cancelled in your wallet. Nothing was sent.';
  if (/insufficient lamports|no record of a prior credit|insufficient funds for fee/i.test(msg))
    return 'Not enough SOL in this wallet for this amount plus the network fee. Nothing was sent.';
  if (/insufficient funds/i.test(msg)) return 'Not enough of that token in this wallet. Nothing was sent.';
  return msg.split(/\. (?:Logs|Catch)/)[0].slice(0, 200) || 'That did not go through.';
}

/**
 * Renders a Solana Action (the same thing blink clients show inside X) and runs
 * it with the visitor's own wallet: fetch the transaction, sign, send, confirm.
 * Works with no XLedger account.
 */
export function ActionPanel({ path, compact = false }: { path: string; compact?: boolean }) {
  const { publicKey, signTransaction } = useWallet();
  const [meta, setMeta] = useState<ActionMeta | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; description: string; url: string | null } | null>(null);

  useEffect(() => {
    getAction(path)
      .then((m) => {
        setMeta(m);
        const defaults: Record<string, string> = {};
        for (const a of m.links?.actions ?? [])
          for (const p of a.parameters ?? []) {
            const sel = p.options?.find((o) => o.selected) ?? p.options?.[0];
            if (sel) defaults[p.name] = sel.value;
          }
        setValues(defaults);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load'));
  }, [path]);

  const run = async (link: ActionLink) => {
    if (!publicKey || !signTransaction) return;
    for (const p of link.parameters ?? []) {
      if (p.required && !values[p.name]) {
        setError(`Enter ${p.label?.toLowerCase() ?? p.name}.`);
        return;
      }
    }
    setError(null);
    setBusy(link.label);
    try {
      const account = publicKey.toBase58();
      const [{ rpcUrl, cluster }, built] = await Promise.all([
        getPublicConfig(),
        postAction(fill(link.href, values), account),
      ]);
      const tx = Transaction.from(base64ToBytes(built.transaction));
      const signed = await signTransaction(tx);
      const conn = new Connection(rpcUrl, 'confirmed');
      const sig: string = await conn.sendRawTransaction(signed.serialize());
      const q = /^mainnet/.test(cluster) ? '' : `?cluster=${cluster}`;
      const url = `https://solscan.io/tx/${sig}${q}`;
      // From here the transfer is out; never offer to send it again.
      setDone({ title: 'Sent!', description: built.message ?? 'Your transfer was submitted.', url });
      try {
        await conn.confirmTransaction(sig, 'confirmed');
        if (built.links?.next?.href) {
          const c = await confirmAction(built.links.next.href, account, sig);
          setDone({ title: c.title, description: c.description.replace(/\s*https?:\/\/\S+$/, ''), url });
        }
      } catch {
        /* recorded later or not at all; the transfer itself is on-chain */
      }
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(null);
    }
  };

  if (!meta) return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;

  if (done) {
    return (
      <div className="action-done">
        <p className="action-done-title">✓ {done.title}</p>
        <p className="muted" style={{ margin: 0 }}>{done.description}</p>
        {done.url && (
          <a href={done.url} target="_blank" rel="noreferrer noopener" className="tx-sig">
            View transaction
          </a>
        )}
      </div>
    );
  }

  const links = meta.links?.actions ?? [];
  const presets = links.filter((l) => !l.parameters?.length);
  const forms = links.filter((l) => l.parameters?.length);

  return (
    <div className={compact ? '' : 'action-panel'}>
      {meta.disabled ? (
        <p className="muted" style={{ margin: 0 }}>{meta.description}</p>
      ) : !publicKey ? (
        <WalletButton />
      ) : (
        <>
          {links.length === 0 && (
            <button className="btn btn-primary" onClick={() => void run({ type: 'transaction', label: meta.label, href: path })} disabled={Boolean(busy)}>
              {busy ? 'Waiting for your wallet…' : meta.label}
            </button>
          )}
          {presets.length > 0 && (
            <div className="preset-row">
              {presets.map((l) => (
                <button key={l.href} className="btn btn-ghost" onClick={() => void run(l)} disabled={Boolean(busy)}>
                  {busy === l.label ? 'Signing…' : l.label}
                </button>
              ))}
            </div>
          )}
          {forms.map((l) => (
            <div key={l.href} className="action-form">
              {l.parameters!.map((p) =>
                p.type === 'select' ? (
                  <select
                    key={p.name}
                    className="input"
                    value={values[p.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                  >
                    {p.options?.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    key={p.name}
                    className="input"
                    inputMode={p.type === 'number' ? 'decimal' : undefined}
                    placeholder={p.label ?? p.name}
                    value={values[p.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value.replace(',', '.') }))}
                  />
                ),
              )}
              <button className="btn btn-primary" style={{ marginTop: 0 }} onClick={() => void run(l)} disabled={Boolean(busy)}>
                {busy === l.label ? 'Waiting for your wallet…' : l.label}
              </button>
            </div>
          ))}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
