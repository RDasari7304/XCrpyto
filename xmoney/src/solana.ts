import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { config, escrowProgramId, attestorKeypair } from './config.js';

export const connection = new Connection(config.solana.rpcUrl, 'confirmed');

export function isValidAddress(addr: unknown): addr is string {
  if (typeof addr !== 'string' || addr.length < 32 || addr.length > 44) return false;
  try {
    return PublicKey.isOnCurve(new PublicKey(addr).toBytes());
  } catch {
    return false;
  }
}

/**
 * The X account identifier committed on-chain. Hashed rather than stored raw so
 * the chain doesn't carry a public index of which X accounts have unclaimed
 * tips waiting.
 */
export function recipientXHash(xUserId: string): Buffer {
  return createHash('sha256').update(`xcrypto:x-user:${xUserId}`).digest();
}

/** Anchor instruction discriminator. */
function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function u64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(value);
  return b;
}

function i64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(value);
  return b;
}

export function escrowPda(sender: PublicKey, xHash: Buffer, nonce: bigint): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), sender.toBuffer(), xHash, u64(nonce)],
    escrowProgramId(),
  );
  return pda;
}

export function createEscrowIx(opts: {
  sender: PublicKey;
  xHash: Buffer;
  lamports: bigint;
  nonce: bigint;
  expiresAt: bigint;
}): { ix: TransactionInstruction; pda: PublicKey } {
  const pda = escrowPda(opts.sender, opts.xHash, opts.nonce);
  const ix = new TransactionInstruction({
    programId: escrowProgramId(),
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: opts.sender, isSigner: true, isWritable: true },
      { pubkey: attestorKeypair().publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      discriminator('create_escrow'),
      opts.xHash,
      u64(opts.lamports),
      u64(opts.nonce),
      i64(opts.expiresAt),
    ]),
  });
  return { ix, pda };
}

export function claimIx(opts: {
  pda: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: escrowProgramId(),
    keys: [
      { pubkey: opts.pda, isSigner: false, isWritable: true },
      { pubkey: opts.sender, isSigner: false, isWritable: true },
      { pubkey: opts.recipient, isSigner: true, isWritable: true },
      { pubkey: attestorKeypair().publicKey, isSigner: true, isWritable: false },
    ],
    data: discriminator('claim'),
  });
}

export function refundIx(opts: { pda: PublicKey; sender: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: escrowProgramId(),
    keys: [
      { pubkey: opts.pda, isSigner: false, isWritable: true },
      { pubkey: opts.sender, isSigner: true, isWritable: true },
    ],
    data: discriminator('refund'),
  });
}

/** Build an unsigned transaction for the client's wallet to sign. */
export async function buildUnsigned(
  feePayer: PublicKey,
  instructions: TransactionInstruction[],
): Promise<{ base64: string; blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ...instructions);
  return {
    base64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    blockhash,
    lastValidBlockHeight,
  };
}

export function transferIx(from: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

/**
 * Confirm on-chain that a signature actually did what the intent claimed.
 * The client tells us a signature; the chain tells us the truth, so we check
 * the destination's balance really rose by the promised amount before marking
 * an intent confirmed.
 */
export async function verifyCredit(
  signature: string,
  destination: PublicKey,
  lamports: bigint,
): Promise<boolean> {
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return false;

  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const index = keys.findIndex((k) => k.equals(destination));
  if (index < 0) return false;

  const pre = BigInt(tx.meta!.preBalances[index]);
  const post = BigInt(tx.meta!.postBalances[index]);
  return post - pre >= lamports;
}
