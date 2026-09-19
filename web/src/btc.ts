import { useCallback, useState } from 'react';

/**
 * Bitcoin support — STEP 1, READ ONLY.
 *
 * Phantom deprecated window.phantom.bitcoin (June 2026). New builds expose BTC
 * only through the Bitcoin Wallet Standard, the same discovery mechanism used
 * for Solana wallets. We try wallet-standard first, then fall back to the
 * legacy injected provider for older Phantom builds. Moves no funds.
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
}

// ---- wallet-standard path -------------------------------------------------

interface StandardWallet {
  name: string;
  chains: readonly string[];
  features: Record<string, any>;
  accounts: readonly {
    address: string;
    publicKey?: Uint8Array;
    chains: readonly string[];
    features: readonly string[];
  }[];
}

function getStandardWallets(): StandardWallet[] {
  const registered: StandardWallet[] = [];

  // Ask any already-loaded wallet-standard wallets to announce themselves.
  const listener = (e: any) => {
    if (e?.detail?.register) {
      e.detail.register((wallet: StandardWallet) => {
        registered.push(wallet);
        return () => {};
      });
    }
  };
  window.addEventListener('wallet-standard:app-ready', listener);
  window.dispatchEvent(new Event('wallet-standard:app-ready'));
  window.removeEventListener('wallet-standard:app-ready', listener);

  // Some builds also expose a shared registry on navigator.
  const existing = (window as any).navigator?.wallets?.get?.() ?? [];
  return [...registered, ...existing];
}

async function probeViaWalletStandard(): Promise<BtcProbeResult | null> {
  const wallets = getStandardWallets();
  const phantom = wallets.find(
    (w) =>
      w.name === 'Phantom' && w.chains.some((c) => c.startsWith('bitcoin:')),
  );
  if (!phantom) return null;

  const connect = phantom.features['standard:connect'];
  if (!connect?.connect) {
    throw new Error('Phantom wallet found but has no connect feature');
  }

  const { accounts } = await connect.connect();

  const btcAccounts: BtcAccount[] = accounts
    .filter((a: any) => a.chains.some((c: string) => c.startsWith('bitcoin:')))
    .map((a: any) => ({
      address: a.address,
      publicKey: a.publicKey ? bytesToHex(a.publicKey) : undefined,
      addressType: inferAddressType(a.address),
      purpose: inferPurpose(a.address),
    }));

  if (btcAccounts.length === 0) return null;
  return buildResult(btcAccounts, 'wallet-standard');
}

// ---- legacy injected path (older Phantom builds) --------------------------

interface LegacyBtcProvider {
  requestAccounts(): Promise<BtcAccount[]>;
}

async function probeViaLegacy(): Promise<BtcProbeResult | null> {
  const p = (window as any).phantom?.bitcoin as LegacyBtcProvider | undefined;
  if (!p) return null;
  const accounts = await p.requestAccounts();
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  return buildResult(accounts, 'legacy');
}

// ---- shared helpers -------------------------------------------------------

function buildResult(
  accounts: BtcAccount[],
  source: BtcProbeResult['source'],
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

  const run = useCallback(async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const std = await probeViaWalletStandard();
      if (std) return setResult(std);
      const legacy = await probeViaLegacy();
      if (legacy) return setResult(legacy);
      throw new Error(
        'Phantom did not expose Bitcoin. Confirm Bitcoin is enabled in Phantom (Settings → Manage Networks → Bitcoin), unlock the wallet, and reload.',
      );
    } catch (err: any) {
      setError(err?.message ?? 'Bitcoin probe failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, result, error };
}
