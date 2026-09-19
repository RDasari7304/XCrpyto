import { useCallback, useState } from 'react';

/**
 * Bitcoin support — STEP 1, READ ONLY.
 *
 * Bitcoin shares nothing with the EVM or Solana pipelines: UTXO model, its own
 * Phantom provider, its own address format and signing (PSBTs). Before writing
 * any of that, this step just proves Phantom's Bitcoin provider is reachable and
 * shows exactly what it returns — so the send/verify code that follows is built
 * on the real API shape, not an assumption. It moves no funds.
 *
 * Phantom injects its BTC provider at window.phantom.bitcoin. `requestAccounts`
 * returns an array of address objects; Phantom typically returns two — a
 * "payment" address (p2sh/segwit, used for spending BTC) and an "ordinals"
 * address (taproot). For sending BTC we care about the PAYMENT address.
 */

interface BtcAccount {
  address: string;
  publicKey?: string;
  addressType?: string; // 'p2tr' | 'p2wpkh' | 'p2sh' ...
  purpose?: string; // 'payment' | 'ordinals'
}

interface BtcProvider {
  requestAccounts(): Promise<BtcAccount[]>;
  // signMessage / signPSBT exist too, but Step 1 does not touch them.
}

function btcProvider(): BtcProvider | null {
  const w = window as unknown as Record<string, any>;
  return w.phantom?.bitcoin ?? null;
}

export interface BtcProbeResult {
  raw: BtcAccount[];
  paymentAddress: string | null;
  ordinalsAddress: string | null;
}

export function useBtcProbe() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BtcProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const p = btcProvider();
      if (!p) throw new Error('No Bitcoin wallet found. Update Phantom, or enable Bitcoin in it.');

      const accounts = await p.requestAccounts();
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error('Phantom returned no Bitcoin accounts');
      }

      // Identify addresses by purpose when Phantom labels them; fall back to
      // address-type heuristics. We only surface them here — no assumptions
      // baked into anything that spends yet.
      const payment =
        accounts.find((a) => a.purpose === 'payment') ??
        accounts.find((a) => a.addressType && a.addressType !== 'p2tr') ??
        accounts[0];
      const ordinals =
        accounts.find((a) => a.purpose === 'ordinals') ??
        accounts.find((a) => a.addressType === 'p2tr') ??
        null;

      setResult({
        raw: accounts,
        paymentAddress: payment?.address ?? null,
        ordinalsAddress: ordinals?.address ?? null,
      });
    } catch (err: any) {
      setError(err?.message ?? 'Bitcoin probe failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, result, error };
}
