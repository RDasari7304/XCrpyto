import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';

/**
 * Minimal wallet layer talking to Phantom / Solflare directly (they inject a
 * provider on `window`), avoiding the five @solana/wallet-adapter packages.
 */

interface Provider {
  publicKey: { toBytes(): Uint8Array; toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  on?(event: string, handler: (arg?: unknown) => void): void;
  removeAllListeners?(event: string): void;
}

type WalletName = 'Phantom' | 'Solflare';

function providerFor(name: WalletName): Provider | null {
  const w = window as unknown as Record<string, any>;
  if (name === 'Phantom') return w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null);
  return w.solflare ?? null;
}

function installedWallets(): WalletName[] {
  return (['Phantom', 'Solflare'] as WalletName[]).filter((n) => providerFor(n));
}

interface WalletState {
  publicKey: PublicKey | null;
  connecting: boolean;
  available: WalletName[];
  connect(name: WalletName): Promise<void>;
  disconnect(): Promise<void>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState<WalletName | null>(null);
  const [publicKey, setPublicKey] = useState<PublicKey | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [available, setAvailable] = useState<WalletName[]>([]);

  // Extensions inject asynchronously, so poll briefly on mount.
  useEffect(() => {
    let tries = 0;
    const timer = setInterval(() => {
      const found = installedWallets();
      if (found.length) setAvailable(found);
      if (found.length > 0 || ++tries > 20) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // Reconnect silently if the user already trusted this site. Also react to the
  // wallet's own account-change events so our state never drifts from the
  // extension's (a stale mismatch was causing spurious "different account"
  // prompts).
  useEffect(() => {
    if (available.length === 0 || publicKey) return;
    const first = available[0];
    const provider = providerFor(first);
    if (!provider) return;

    let cancelled = false;
    provider
      .connect({ onlyIfTrusted: true })
      .then((res) => {
        if (cancelled) return;
        setName(first);
        setPublicKey(new PublicKey(res.publicKey.toBase58()));
      })
      .catch(() => {});

    provider.on?.('accountChanged', (pk: unknown) => {
      if (pk && typeof (pk as any).toBase58 === 'function') {
        setPublicKey(new PublicKey((pk as any).toBase58()));
      } else {
        setPublicKey(null);
        setName(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [available, publicKey]);

  const connect = useCallback(async (which: WalletName) => {
    const provider = providerFor(which);
    if (!provider) throw new Error(`${which} is not installed`);
    setConnecting(true);
    try {
      const res = await provider.connect();
      setName(which);
      setPublicKey(new PublicKey(res.publicKey.toBase58()));
      provider.on?.('disconnect', () => {
        setPublicKey(null);
        setName(null);
      });
      provider.on?.('accountChanged', (pk: unknown) => {
        if (pk && typeof (pk as any).toBase58 === 'function') {
          setPublicKey(new PublicKey((pk as any).toBase58()));
        } else {
          setPublicKey(null);
          setName(null);
        }
      });
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (name) {
      const p = providerFor(name);
      await p?.disconnect().catch(() => {});
    }
    setPublicKey(null);
    setName(null);
  }, [name]);

  const requireProvider = (): Provider => {
    const provider = name ? providerFor(name) : null;
    if (!provider) throw new Error('Connect a wallet first');
    return provider;
  };

  const signMessage = useCallback(
    async (message: Uint8Array) => (await requireProvider().signMessage(message, 'utf8')).signature,
    [name],
  );

  const signTransaction = useCallback(
    async (tx: Transaction) => requireProvider().signTransaction(tx),
    [name],
  );

  return (
    <WalletContext.Provider
      value={{ publicKey, connecting, available, connect, disconnect, signMessage, signTransaction }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside WalletProvider');
  return ctx;
}

export function WalletButton() {
  const { publicKey, connecting, available, connect, disconnect } = useWallet();

  if (publicKey) {
    const addr = publicKey.toBase58();
    return (
      <button className="btn btn-ghost" onClick={() => void disconnect()}>
        {addr.slice(0, 4)}…{addr.slice(-4)} · Disconnect
      </button>
    );
  }

  if (available.length === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No Solana wallet detected. Install{' '}
        <a href="https://phantom.app/download" target="_blank" rel="noreferrer noopener">
          Phantom
        </a>{' '}
        or{' '}
        <a href="https://solflare.com/download" target="_blank" rel="noreferrer noopener">
          Solflare
        </a>
        , then reload.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      {available.map((w) => (
        <button key={w} className="btn btn-primary" disabled={connecting} onClick={() => void connect(w)}>
          {connecting ? 'Connecting…' : `Connect ${w}`}
        </button>
      ))}
    </div>
  );
}

/** Browsers have no Buffer, so base64 goes through atob. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
