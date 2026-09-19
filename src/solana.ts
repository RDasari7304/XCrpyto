import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { config, escrowProgramId, attestorKeypair } from './config.js';
import type { TokenInfo } from './tokens.js';

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
 * Which token program owns a mint. Newer tokens (many pump.fun ones, including
 * some we allowlist) are Token-2022, which is a different on-chain program from
 * the legacy SPL Token program. Every account and instruction for that mint —
 * the ATA derivation, the create-ATA, and the transfer — must target the same
 * program, or the chain rejects it with "IncorrectProgramId".
 *
 * We read the mint account's owner to decide, and cache it since a mint's owner
 * never changes.
 */
const mintProgramCache = new Map<string, PublicKey>();

export async function tokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
  const key = mint.toBase58();
  const cached = mintProgramCache.get(key);
  if (cached) return cached;

  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${key} not found on ${config.solana.cluster}`);
  // The account's owner IS the token program that governs it.
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
  mintProgramCache.set(key, program);
  return program;
}

/**
 * Build the instructions to send an SPL token from `from` to `to`.
 *
 * SPL tokens don't live at a wallet address directly — each (wallet, mint) pair
 * has an "associated token account" (ATA) that holds that token. So:
 *  - resolve the correct token program for this mint (legacy or Token-2022),
 *  - resolve both sides' ATAs under that program,
 *  - if the recipient has never held this token, prepend an instruction that
 *    creates their ATA (the sender pays the ~0.002 SOL rent for it),
 *  - transfer with `transferChecked`, which verifies mint and decimals on-chain
 *    so a wrong-decimals bug can't silently move the wrong amount.
 */
export async function splTransferIxs(opts: {
  from: PublicKey;
  to: PublicKey;
  mint: PublicKey;
  amount: bigint;
  decimals: number;
}): Promise<{ ixs: TransactionInstruction[]; destTokenAccount: PublicKey }> {
  const programId = await tokenProgramForMint(opts.mint);
  const fromAta = await getAssociatedTokenAddress(
    opts.mint,
    opts.from,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const toAta = await getAssociatedTokenAddress(
    opts.mint,
    opts.to,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const ixs: TransactionInstruction[] = [];

  let recipientHasAta = true;
  try {
    await getAccount(connection, toAta, undefined, programId);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) recipientHasAta = false;
    else throw err;
  }
  if (!recipientHasAta) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        opts.from,
        toAta,
        opts.to,
        opts.mint,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  ixs.push(
    createTransferCheckedInstruction(
      fromAta,
      opts.mint,
      toAta,
      opts.from,
      opts.amount,
      opts.decimals,
      [],
      programId,
    ),
  );
  return { ixs, destTokenAccount: toAta };
}

/** The account whose balance should rise: the wallet for SOL, the ATA for SPL. */
export async function creditDestination(
  wallet: PublicKey,
  token: TokenInfo,
): Promise<PublicKey> {
  if (!token.mint) return wallet;
  const programId = await tokenProgramForMint(token.mint);
  return getAssociatedTokenAddress(
    token.mint,
    wallet,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

/**
 * Confirm on-chain that a signature actually did what the intent claimed.
 * The client tells us a signature; the chain tells us the truth.
 *
 * For SOL we compare the destination wallet's lamport balance.
 *
 * For SPL we do NOT try to resolve the recipient's token-account index (that
 * account may be created in the same transaction, or live in a lookup table,
 * and index matching is fragile — this produced false "did not land" errors on
 * transfers that actually succeeded). Instead we read the transaction's
 * pre/post TOKEN balances, which the RPC tags with mint + owner directly, and
 * check that the recipient owner's balance of this mint rose by the amount.
 */
export async function verifyCredit(opts: {
  signature: string;
  amount: bigint;
  // SOL:
  destination?: PublicKey;
  // SPL:
  mint?: PublicKey;
  ownerWallet?: PublicKey;
}): Promise<boolean> {
  const tx = await connection.getTransaction(opts.signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta?.err) return false;

  // SPL: match on mint + owner, no index resolution.
  if (opts.mint && opts.ownerWallet) {
    const mint = opts.mint.toBase58();
    const owner = opts.ownerWallet.toBase58();
    const match = (b: { mint: string; owner?: string }) => b.mint === mint && b.owner === owner;
    const pre = tx.meta?.preTokenBalances?.find(match);
    const post = tx.meta?.postTokenBalances?.find(match);
    const preAmt = BigInt(pre?.uiTokenAmount.amount ?? '0');
    const postAmt = BigInt(post?.uiTokenAmount.amount ?? '0');
    return postAmt - preAmt >= opts.amount;
  }

  // SOL: compare the destination wallet's lamport balance.
  if (opts.destination) {
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
    const index = keys.findIndex((k) => k.equals(opts.destination!));
    if (index < 0) return false;
    const pre = BigInt(tx.meta!.preBalances[index]);
    const post = BigInt(tx.meta!.postBalances[index]);
    return post - pre >= opts.amount;
  }

  return false;
}
