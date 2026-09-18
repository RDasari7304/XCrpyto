import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { config, db, lamportsToSol } from './config.js';
import {
  buildUnsigned,
  createEscrowIx,
  escrowPda,
  recipientXHash,
  transferIx,
  verifyCredit,
} from './solana.js';

export interface Intent {
  id: string;
  sender_user_id: string;
  recipient_x_user_id: string;
  recipient_x_handle: string | null;
  recipient_wallet: string | null;
  lamports: string;
  route: 'direct' | 'escrow';
  status: string;
  escrow_nonce: string | null;
  escrow_pda: string | null;
  tx_signature: string | null;
  expires_at: string;
  created_at: string;
}

function randomNonce(): bigint {
  return BigInt('0x' + randomBytes(7).toString('hex'));
}

/**
 * Record a tip the sender still has to approve. Deliberately does not touch the
 * chain: the app has no authority to move the sender's SOL just because they
 * once logged in with X.
 */
export async function createIntent(opts: {
  senderUserId: string;
  recipientXUserId: string;
  recipientXHandle: string | null;
  lamports: bigint;
  sourceTweetId: string;
}): Promise<Intent | null | 'recipient_not_registered'> {
  const { rows: recipientRows } = await db.query<{ wallet: string | null }>(
    `SELECT wallet FROM users WHERE x_user_id = $1 AND wallet IS NOT NULL`,
    [opts.recipientXUserId],
  );
  const recipientWallet = recipientRows[0]?.wallet ?? null;
  // Direct-only mode: without the escrow program deployed there is nowhere safe
  // to put a tip for someone who has not connected a wallet.
  if (!recipientWallet && !config.solana.escrowEnabled) return 'recipient_not_registered';
  const route = recipientWallet ? 'direct' : 'escrow';
  const nonce = route === 'escrow' ? randomNonce() : null;

  const { rows } = await db.query<Intent>(
    `INSERT INTO tip_intents
       (sender_user_id, recipient_x_user_id, recipient_x_handle, recipient_wallet,
        lamports, route, escrow_nonce, source_tweet_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' minutes')::interval)
     ON CONFLICT (source_tweet_id) DO NOTHING
     RETURNING *`,
    [
      opts.senderUserId,
      opts.recipientXUserId,
      opts.recipientXHandle,
      recipientWallet,
      opts.lamports.toString(),
      route,
      nonce?.toString() ?? null,
      opts.sourceTweetId,
      String(config.limits.intentTtlMinutes),
    ],
  );
  return rows[0] ?? null;
}

export async function getIntentForSender(id: string, senderUserId: string): Promise<Intent | null> {
  // Scoped by sender: an intent id is never enough to see or act on someone
  // else's proposed tip.
  const { rows } = await db.query<Intent>(
    `SELECT * FROM tip_intents WHERE id = $1 AND sender_user_id = $2`,
    [id, senderUserId],
  );
  return rows[0] ?? null;
}

export class IntentError extends Error {}

/**
 * Build the exact transaction the sender is about to sign. The server chooses
 * the recipient address from the database, never from the request body, so a
 * tampered client cannot redirect a tip.
 */
export async function buildIntentTransaction(
  intent: Intent,
  senderWallet: string,
): Promise<{ base64: string; description: Record<string, string> }> {
  if (intent.status !== 'awaiting_approval') {
    throw new IntentError(`This tip is already ${intent.status}.`);
  }
  if (new Date(intent.expires_at) < new Date()) {
    await db.query(`UPDATE tip_intents SET status = 'expired' WHERE id = $1`, [intent.id]);
    throw new IntentError('This tip request expired. Post the reply again to redo it.');
  }

  const sender = new PublicKey(senderWallet);
  const lamports = BigInt(intent.lamports);

  if (intent.route === 'direct') {
    // Re-read the recipient's wallet now, in case they changed it after the
    // intent was created.
    const { rows } = await db.query<{ wallet: string | null }>(
      `SELECT wallet FROM users WHERE x_user_id = $1`,
      [intent.recipient_x_user_id],
    );
    const wallet = rows[0]?.wallet;
    if (!wallet) throw new IntentError('The recipient no longer has a wallet connected.');
    if (wallet === senderWallet) throw new IntentError('That is your own wallet.');

    const tx = await buildUnsigned(sender, [transferIx(sender, new PublicKey(wallet), lamports)]);
    await db.query(`UPDATE tip_intents SET recipient_wallet = $2 WHERE id = $1`, [
      intent.id,
      wallet,
    ]);
    return {
      base64: tx.base64,
      description: {
        route: 'direct',
        amount: lamportsToSol(lamports),
        to: wallet,
      },
    };
  }

  const xHash = recipientXHash(intent.recipient_x_user_id);
  const nonce = BigInt(intent.escrow_nonce!);
  const expiresAt = BigInt(
    Math.floor(Date.now() / 1000) + config.limits.escrowTtlDays * 24 * 3600,
  );
  const { ix, pda } = createEscrowIx({ sender, xHash, lamports, nonce, expiresAt });
  const tx = await buildUnsigned(sender, [ix]);

  await db.query(`UPDATE tip_intents SET escrow_pda = $2 WHERE id = $1`, [
    intent.id,
    pda.toBase58(),
  ]);

  return {
    base64: tx.base64,
    description: {
      route: 'escrow',
      amount: lamportsToSol(lamports),
      escrow: pda.toBase58(),
      refundableAfter: new Date(Number(expiresAt) * 1000).toISOString(),
    },
  };
}

/**
 * Called after the wallet submits. We verify against the chain rather than
 * trusting the client's claim that it worked.
 */
export async function confirmIntent(
  intent: Intent,
  signature: string,
  senderWallet: string,
): Promise<void> {
  const lamports = BigInt(intent.lamports);
  const destination =
    intent.route === 'direct'
      ? new PublicKey(intent.recipient_wallet!)
      : escrowPda(new PublicKey(senderWallet), recipientXHash(intent.recipient_x_user_id), BigInt(intent.escrow_nonce!));

  const ok = await verifyCredit(signature, destination, lamports);
  if (!ok) throw new IntentError('That transaction did not land as described.');

  await db.query(
    `UPDATE tip_intents SET status = 'confirmed', tx_signature = $2, confirmed_at = now()
      WHERE id = $1 AND status IN ('awaiting_approval', 'submitted')`,
    [intent.id, signature],
  );

  if (intent.route === 'escrow') {
    const { rows } = await db.query<{ x_handle: string | null }>(
      `SELECT x_handle FROM users WHERE id = $1`,
      [intent.sender_user_id],
    );
    await db.query(
      `INSERT INTO escrows
         (pda, intent_id, sender_wallet, sender_x_handle, recipient_x_user_id,
          recipient_x_hash, lamports, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               now() + ($9 || ' days')::interval)
       ON CONFLICT (pda) DO NOTHING`,
      [
        destination.toBase58(),
        intent.id,
        senderWallet,
        rows[0]?.x_handle ?? null,
        intent.recipient_x_user_id,
        recipientXHash(intent.recipient_x_user_id).toString('hex'),
        intent.lamports,
        intent.escrow_nonce,
        String(config.limits.escrowTtlDays),
      ],
    );
  }
}
