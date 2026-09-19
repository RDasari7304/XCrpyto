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

/**
 * EVM transfer layer for Robinhood Chain. These are the functions the
 * mention→approve flow calls to send on chain 4663; the dashboard test panel
 * calls the exact same code so the money-moving path is exercised in isolation
 * before a real mention triggers it.
 *
 * Native ETH transfer: eth_sendTransaction with a value.
 * ERC-20 transfer: eth_sendTransaction to the contract with encoded
 *   transfer(address,uint256) calldata (selector 0xa9059cbb).
 * Confirmation: poll eth_getTransactionReceipt until it has a block and
 *   status 0x1 (success).
 */

function pad32(hexNo0x: string): string {
  return hexNo0x.padStart(64, '0');
}

/** Encode ERC-20 transfer(to, amount) calldata. */
function encodeErc20Transfer(to: string, amount: bigint): string {
  const selector = 'a9059cbb';
  const addr = pad32(to.toLowerCase().replace(/^0x/, ''));
  const amt = pad32(amount.toString(16));
  return '0x' + selector + addr + amt;
}

export interface EvmSendParams {
  from: string;
  to: string;
  amount: bigint; // base units (wei for ETH, token base units for ERC-20)
  contract?: string; // ERC-20 contract; omit for native ETH
}

/** Build + send a transfer, returning the tx hash. Requires user signature. */
export async function evmSend(params: EvmSendParams): Promise<string> {
  const p = evmProvider();
  if (!p) throw new Error('No EVM wallet found');

  // Make sure we're on Robinhood Chain before signing.
  await ensureChain(p);
  const chainHex: string = await p.request({ method: 'eth_chainId' });
  if (parseInt(chainHex, 16) !== ROBINHOOD_CHAIN.chainIdDec) {
    throw new Error('Wallet is not on Robinhood Chain');
  }

  const tx: Record<string, string> = { from: params.from };
  if (params.contract) {
    tx.to = params.contract;
    tx.value = '0x0';
    tx.data = encodeErc20Transfer(params.to, params.amount);
  } else {
    tx.to = params.to;
    tx.value = '0x' + params.amount.toString(16);
  }

  const hash: string = await p.request({ method: 'eth_sendTransaction', params: [tx] });
  return hash;
}

/** Poll for the receipt until confirmed. Throws on revert or timeout. */
export async function evmConfirm(hash: string, timeoutMs = 90_000): Promise<void> {
  const p = evmProvider();
  if (!p) throw new Error('No EVM wallet found');
  const start = Date.now();
  for (;;) {
    const receipt = await p.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt && receipt.blockNumber) {
      if (receipt.status === '0x1') return;
      throw new Error('Transaction reverted on chain');
    }
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for confirmation');
    await new Promise((r) => setTimeout(r, 2500));
  }
}

/** Read an ERC-20 balance for an address (base units). */
export async function evmErc20Balance(contract: string, address: string): Promise<bigint> {
  const p = evmProvider();
  if (!p) throw new Error('No EVM wallet found');
  const data = '0x70a08231' + pad32(address.toLowerCase().replace(/^0x/, '')); // balanceOf(address)
  const res: string = await p.request({ method: 'eth_call', params: [{ to: contract, data }, 'latest'] });
  return BigInt(res);
}

export function currentEvmAddress(): Promise<string | null> {
  const p = evmProvider();
  if (!p) return Promise.resolve(null);
  return p
    .request({ method: 'eth_accounts' })
    .then((a: string[]) => a[0] ?? null)
    .catch(() => null);
}
