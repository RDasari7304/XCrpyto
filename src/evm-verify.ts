/**
 * Server-side verification of Robinhood Chain (EVM) transfers. The client signs
 * and broadcasts via Phantom's EVM provider, then tells us the tx hash — but we
 * confirm against the chain ourselves before marking an intent settled, exactly
 * as we do for Solana. We check: the receipt exists and succeeded, and the
 * ERC-20 Transfer log shows `amount` going to the expected recipient.
 */

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Public RPCs (polygon-rpc.com, HyperEVM, etc.) often lag between a receipt
 * being confirmed and the tx being queryable — so a single check right after
 * the client confirms can see null and wrongly report "did not land". Retry a
 * few times with backoff before giving up.
 */
async function withRetry<T>(fn: () => Promise<T | null | false>, tries = 6, delayMs = 2500): Promise<T | null | false> {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`EVM RPC ${method} -> ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`EVM RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

interface EvmLog {
  address: string;
  topics: string[];
  data: string;
}
interface EvmReceipt {
  status: string; // 0x1 success, 0x0 revert
  blockNumber: string | null;
  logs: EvmLog[];
}

function topicToAddress(topic: string): string {
  // address is right-padded in a 32-byte topic
  return ('0x' + topic.slice(-40)).toLowerCase();
}

/**
 * Verify an ERC-20 transfer of at least `amount` base units to `recipient`,
 * emitted by `contract`, in the given tx, on the given chain's RPC.
 */
export async function verifyEvmErc20Transfer(opts: {
  rpcUrl: string;
  txHash: string;
  contract: string;
  recipient: string;
  amount: bigint;
}): Promise<boolean> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(opts.txHash)) return false;
  const contract = opts.contract.toLowerCase();
  const recipient = opts.recipient.toLowerCase();
  const result = await withRetry(async () => {
    let receipt: EvmReceipt | null;
    try {
      receipt = await rpcCall<EvmReceipt | null>(opts.rpcUrl, 'eth_getTransactionReceipt', [opts.txHash]);
    } catch {
      return false;
    }
    if (!receipt || !receipt.blockNumber || receipt.status !== '0x1') return false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== contract) continue;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      const to = topicToAddress(log.topics[2] ?? '');
      if (to !== recipient) continue;
      let value: bigint;
      try {
        value = BigInt(log.data);
      } catch {
        continue;
      }
      if (value >= opts.amount) return true;
    }
    return false;
  });
  return result === true;
}

interface EvmTx {
  to: string | null;
  value: string; // hex wei
}

/**
 * Verify a native transfer (BNB/ETH gas token) of at least `amount` wei to
 * `recipient`. Checks the tx succeeded and its `to`/`value` match.
 */
export async function verifyEvmNativeTransfer(opts: {
  rpcUrl: string;
  txHash: string;
  recipient: string;
  amount: bigint;
}): Promise<boolean> {
  if (!/^0x[a-fA-F0-9]{64}$/.test(opts.txHash)) return false;
  const result = await withRetry(async () => {
    try {
      const receipt = await rpcCall<EvmReceipt | null>(opts.rpcUrl, 'eth_getTransactionReceipt', [opts.txHash]);
      if (!receipt || !receipt.blockNumber || receipt.status !== '0x1') return false;
      const tx = await rpcCall<EvmTx | null>(opts.rpcUrl, 'eth_getTransactionByHash', [opts.txHash]);
      if (!tx || !tx.to) return false;
      if (tx.to.toLowerCase() !== opts.recipient.toLowerCase()) return false;
      return BigInt(tx.value) >= opts.amount ? true : false;
    } catch {
      return false;
    }
  });
  return result === true;
}
