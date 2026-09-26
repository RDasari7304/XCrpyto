import { useCallback, useState } from 'react';
import { getWallets } from '@wallet-standard/app';

/**
 * Bitcoin support — STEP 1, READ ONLY.
 *
 * Phantom deprecated window.phantom.bitcoin (June 2026). New builds expose BTC
 * only through the Bitcoin Wallet Standard, discovered via @wallet-standard/app.
 * We try wallet-standard first, then fall back to the legacy injected provider
 * for older Phantom builds. Moves no funds.
 */

interface BtcAccount {
  address: string;
  publicKey?: string;
  addressType?: string; // 'p2tr' | 'p2wpkh' | 'p2sh' | 'p2pkh'
  purpose?: string;     // 'payment' | 'ordinals'
}

export interface BtcProbeResult {
  raw: BtcAccount[];
  paymentAddress: string | null;
  ordinalsAddress: string | null;
  source: 'wallet-standard' | 'legacy';
  diagnostics: string[];
}

// ---- wallet-standard path -------------------------------------------------

async function probeViaWalletStandard(diag: string[]): Promise<BtcProbeResult | null> {
  const { get } = getWallets();
  const wallets = get();

  diag.push(`wallet-standard: ${wallets.length} wallet(s) registered`);
  for (const w of wallets) {
    diag.push(
      `  • ${w.name} — chains: [${w.chains.join(', ') || 'none'}] — features: [${Object.keys(w.features).join(', ')}]`,
    );
  }

  const phantom = wallets.find(
    (w) => w.name === 'Phantom' && w.chains.some((c) => c.startsWith('bitcoin:')),
  );
  if (!phantom) {
    diag.push('wallet-standard: no Phantom wallet with a bitcoin: chain');
    return null;
  }

  const connect = (phantom.features as any)['standard:connect'];
  if (!connect?.connect) {
    diag.push('wallet-standard: Phantom is registered but exposes no standard:connect feature');
    return null;
  }

  const { accounts } = await connect.connect();
  diag.push(`wallet-standard: Phantom returned ${accounts.length} account(s) after connect`);

  const btcAccounts: BtcAccount[] = accounts
    .filter((a: any) => a.chains.some((c: string) => c.startsWith('bitcoin:')))
    .map((a: any) => ({
      address: a.address,
      publicKey: a.publicKey ? bytesToHex(a.publicKey) : undefined,
      addressType: inferAddressType(a.address),
      purpose: inferPurpose(a.address),
    }));

  if (btcAccounts.length === 0) {
    diag.push('wallet-standard: none of Phantom’s accounts are on a bitcoin: chain');
    return null;
  }
  return buildResult(btcAccounts, 'wallet-standard', diag);
}

// ---- legacy injected path (older Phantom builds) --------------------------

interface LegacyBtcProvider {
  requestAccounts(): Promise<BtcAccount[]>;
}

async function probeViaLegacy(diag: string[]): Promise<BtcProbeResult | null> {
  const p = (window as any).phantom?.bitcoin as LegacyBtcProvider | undefined;
  if (!p) {
    diag.push('legacy: window.phantom.bitcoin is undefined');
    return null;
  }
  diag.push('legacy: window.phantom.bitcoin is present — calling requestAccounts()');
  const accounts = await p.requestAccounts();
  if (!Array.isArray(accounts) || accounts.length === 0) {
    diag.push('legacy: requestAccounts returned no accounts');
    return null;
  }
  diag.push(`legacy: got ${accounts.length} account(s)`);
  return buildResult(accounts, 'legacy', diag);
}

// ---- shared helpers -------------------------------------------------------

function buildResult(
  accounts: BtcAccount[],
  source: BtcProbeResult['source'],
  diag: string[],
): BtcProbeResult {
  const payment =
    accounts.find((a) => a.purpose === 'payment') ??
    accounts.find((a) => a.addressType && a.addressType !== 'p2tr') ??
    accounts[0];
  const ordinals =
    accounts.find((a) => a.purpose === 'ordinals') ??
    accounts.find((a) => a.addressType === 'p2tr') ??
    null;
  return {
    raw: accounts,
    paymentAddress: payment?.address ?? null,
    ordinalsAddress: ordinals?.address ?? null,
    source,
    diagnostics: diag,
  };
}

function inferAddressType(addr: string): string | undefined {
  if (addr.startsWith('bc1p') || addr.startsWith('tb1p')) return 'p2tr';
  if (addr.startsWith('bc1q') || addr.startsWith('tb1q')) return 'p2wpkh';
  if (addr.startsWith('3') || addr.startsWith('2')) return 'p2sh';
  if (addr.startsWith('1') || addr.startsWith('m') || addr.startsWith('n')) return 'p2pkh';
  return undefined;
}

function inferPurpose(addr: string): 'ordinals' | 'payment' | undefined {
  const t = inferAddressType(addr);
  if (t === 'p2tr') return 'ordinals';
  if (t) return 'payment';
  return undefined;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// ---- hook -----------------------------------------------------------------

export function useBtcProbe() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BtcProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);

  const run = useCallback(async () => {
    setError(null);
    setResult(null);
    setDiagnostics([]);
    setBusy(true);
    const diag: string[] = [];
    try {
      const std = await probeViaWalletStandard(diag);
      if (std) {
        setDiagnostics(diag);
        return setResult(std);
      }
      const legacy = await probeViaLegacy(diag);
      if (legacy) {
        setDiagnostics(diag);
        return setResult(legacy);
      }
      setDiagnostics(diag);
      // eslint-disable-next-line no-console
      console.log('[btc probe] diagnostics:\n' + diag.join('\n'));
      throw new Error(
        'Phantom did not expose Bitcoin. See diagnostics below (and the browser console).',
      );
    } catch (err: any) {
      setDiagnostics(diag);
      // eslint-disable-next-line no-console
      console.log('[btc probe] diagnostics:\n' + diag.join('\n'));
      setError(err?.message ?? 'Bitcoin probe failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, result, error, diagnostics };
}
