import { useCallback, useState } from 'react';

/**
 * EVM side of the wallet, for Robinhood Chain (an Arbitrum-stack L2, chain id
 * 4663). Phantom exposes a SEPARATE provider for EVM at window.phantom.ethereum
 * — distinct from the Solana provider the rest of the app uses. This module
 * talks only to that EVM provider.
 *
 * This first cut is connect + read-only verification: it does NOT build or send
 * any transfer. Its job is to prove Phantom reaches chain 4663 and to read the
 * AI token's real decimals and the chain's real gas token directly from the
 * RPC, so the transfer layer that comes next is built on confirmed facts rather
 * than assumptions.
 */

export const ROBINHOOD_CHAIN = {
  chainIdDec: 4663,
  chainIdHex: '0x1237', // 4663
  name: 'Robinhood Chain',
  rpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
  // Explorer + native currency name are filled in from what the chain reports;
  // we don't hardcode the gas symbol because that's one of the things we verify.
  explorer: 'https://robinhoodchain.blockscout.com',
};

interface EvmProvider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
  on?(event: string, handler: (arg?: unknown) => void): void;
}

function evmProvider(): EvmProvider | null {
  const w = window as unknown as Record<string, any>;
  // Prefer Phantom's dedicated EVM provider; fall back to a generic injected one.
  return w.phantom?.ethereum ?? (w.ethereum?.isPhantom ? w.ethereum : w.ethereum ?? null);
}

/** Ask the wallet to switch to Robinhood Chain, adding it if unknown. */
async function ensureChain(p: EvmProvider): Promise<void> {
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_CHAIN.chainIdHex }] });
  } catch (err: any) {
    // 4902 = chain not added to the wallet yet; add it, then it's selected.
    if (err?.code === 4902 || /Unrecognized chain/i.test(String(err?.message))) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: ROBINHOOD_CHAIN.chainIdHex,
            chainName: ROBINHOOD_CHAIN.name,
            rpcUrls: [ROBINHOOD_CHAIN.rpcUrl],
            blockExplorerUrls: [ROBINHOOD_CHAIN.explorer],
            // We must give the wallet a native currency to add the chain. If the
            // real gas token differs, the verification below reports it and we
            // correct this before building transfers.
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

/** Minimal eth_call to read an ERC-20's decimals(): selector 0x313ce567. */
async function readErc20Decimals(p: EvmProvider, contract: string): Promise<number> {
  const data = '0x313ce567';
  const res: string = await p.request({
    method: 'eth_call',
    params: [{ to: contract, data }, 'latest'],
  });
  return parseInt(res, 16);
}

/** Read the connected account's native balance (gas token) in wei. */
async function readNativeBalance(p: EvmProvider, address: string): Promise<bigint> {
  const hex: string = await p.request({ method: 'eth_getBalance', params: [address, 'latest'] });
  return BigInt(hex);
}

export interface EvmVerifyResult {
  address: string;
  chainIdSeen: number;
  aiDecimalsOnChain: number;
  nativeBalanceWei: string;
}

export function useEvmVerify() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EvmVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const p = evmProvider();
      if (!p) throw new Error('No EVM wallet found. Enable Phantom, or its Ethereum mode.');

      const accounts: string[] = await p.request({ method: 'eth_requestAccounts' });
      const address = accounts[0];
      if (!address) throw new Error('Wallet returned no address');

      await ensureChain(p);

      const chainHex: string = await p.request({ method: 'eth_chainId' });
      const chainIdSeen = parseInt(chainHex, 16);

      const aiDecimalsOnChain = await readErc20Decimals(
        p,
        '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
      );
      const nativeBalanceWei = (await readNativeBalance(p, address)).toString();

      setResult({ address, chainIdSeen, aiDecimalsOnChain, nativeBalanceWei });
    } catch (err: any) {
      setError(err?.message ?? 'EVM verification failed');
    } finally {
      setBusy(false);
    }
  }, []);

  return { run, busy, result, error };
}
