import { createHash } from 'node:crypto';
import * as anchor from '@coral-xyz/anchor';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { assert } from 'chai';

/**
 * The escrow program is the only thing standing between a user's SOL and a bug,
 * so these tests are written adversarially: every test that matters here is a
 * test that something is *refused*.
 */

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// Untyped on purpose: target/types/* only exists after `anchor build`, and
// coupling the test file to build output makes a clean checkout fail to typecheck.
const program = anchor.workspace.XcryptoEscrow as anchor.Program<anchor.Idl>;

const TIP = new anchor.BN(0.5 * LAMPORTS_PER_SOL);
const DAY = 24 * 60 * 60;

function xHash(xUserId: string): Buffer {
  return createHash('sha256').update(`xcrypto:x-user:${xUserId}`).digest();
}

function nonceBN(): anchor.BN {
  return new anchor.BN(Math.floor(Math.random() * 2 ** 48));
}

function pdaFor(sender: PublicKey, hash: Buffer, nonce: anchor.BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), sender.toBuffer(), hash, nonce.toArrayLike(Buffer, 'le', 8)],
    program.programId,
  );
  return pda;
}

async function fund(pubkey: PublicKey, sol = 5): Promise<void> {
  const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Asserts the promise rejects, and that the reason mentions `needle`. */
async function rejectsWith(promise: Promise<unknown>, needle: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err) + JSON.stringify(err ?? {});
    assert.include(
      message.toLowerCase(),
      needle.toLowerCase(),
      `rejected, but not for the expected reason: ${message}`,
    );
    return;
  }
  assert.fail(`expected rejection containing "${needle}", but it succeeded`);
}

interface Escrow {
  sender: Keypair;
  recipient: Keypair;
  attestor: Keypair;
  hash: Buffer;
  nonce: anchor.BN;
  pda: PublicKey;
}

async function createEscrow(opts?: {
  amount?: anchor.BN;
  expiresAt?: number;
  attestor?: Keypair;
  xUserId?: string;
}): Promise<Escrow> {
  const sender = Keypair.generate();
  const recipient = Keypair.generate();
  const attestor = opts?.attestor ?? Keypair.generate();
  await fund(sender.publicKey);
  await fund(recipient.publicKey, 1);
  await fund(attestor.publicKey, 1);

  const hash = xHash(opts?.xUserId ?? '42424242');
  const nonce = nonceBN();
  const pda = pdaFor(sender.publicKey, hash, nonce);

  await program.methods
    .createEscrow(
      Array.from(hash),
      opts?.amount ?? TIP,
      nonce,
      new anchor.BN(opts?.expiresAt ?? nowSeconds() + 30 * DAY),
    )
    .accounts({
      escrow: pda,
      sender: sender.publicKey,
      attestor: attestor.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([sender])
    .rpc();

  return { sender, recipient, attestor, hash, nonce, pda };
}

function claimBuilder(e: Escrow, overrides?: { recipient?: PublicKey; attestor?: PublicKey }) {
  return program.methods.claim().accounts({
    escrow: e.pda,
    sender: e.sender.publicKey,
    recipient: overrides?.recipient ?? e.recipient.publicKey,
    attestor: overrides?.attestor ?? e.attestor.publicKey,
  });
}

describe('xcrypto-escrow', () => {
  describe('create_escrow', () => {
    it('holds the tip plus rent in a program-owned PDA', async () => {
      const e = await createEscrow();

      const info = await provider.connection.getAccountInfo(e.pda);
      assert.isNotNull(info, 'escrow account should exist');
      assert.isTrue(info!.owner.equals(program.programId), 'PDA must be program-owned');
      assert.isAbove(
        info!.lamports,
        TIP.toNumber(),
        'PDA holds the tip on top of its rent deposit',
      );

      const account = await program.account.escrow.fetch(e.pda);
      assert.equal(account.amount.toString(), TIP.toString());
      assert.isTrue(account.sender.equals(e.sender.publicKey));
      assert.isTrue(account.attestor.equals(e.attestor.publicKey));
      assert.deepEqual(Buffer.from(account.recipientXHash), e.hash);
    });

    it('refuses a zero amount', async () => {
      await rejectsWith(createEscrow({ amount: new anchor.BN(0) }), 'ZeroAmount');
    });

    it('refuses an expiry in the past', async () => {
      await rejectsWith(createEscrow({ expiresAt: nowSeconds() - 60 }), 'ExpiryInPast');
    });

    it('refuses an expiry beyond the 90 day ceiling', async () => {
      await rejectsWith(createEscrow({ expiresAt: nowSeconds() + 120 * DAY }), 'ExpiryTooFar');
    });

    it('refuses a second escrow on the same PDA', async () => {
      const e = await createEscrow();
      // Same sender, same recipient hash, same nonce -> same address, already initialised.
      await rejectsWith(
        program.methods
          .createEscrow(Array.from(e.hash), TIP, e.nonce, new anchor.BN(nowSeconds() + DAY))
          .accounts({
            escrow: e.pda,
            sender: e.sender.publicKey,
            attestor: e.attestor.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([e.sender])
          .rpc(),
        'already in use',
      );
    });
  });

  describe('claim', () => {
    it('pays the recipient and returns the rent to the sender', async () => {
      const e = await createEscrow();
      const recipientBefore = await provider.connection.getBalance(e.recipient.publicKey);
      const senderBefore = await provider.connection.getBalance(e.sender.publicKey);
      const escrowLamports = (await provider.connection.getAccountInfo(e.pda))!.lamports;
      const rent = escrowLamports - TIP.toNumber();

      await claimBuilder(e).signers([e.recipient, e.attestor]).rpc();

      const recipientAfter = await provider.connection.getBalance(e.recipient.publicKey);
      const senderAfter = await provider.connection.getBalance(e.sender.publicKey);

      // Recipient is the fee payer here, so allow for the signature fee.
      assert.approximately(
        recipientAfter - recipientBefore,
        TIP.toNumber(),
        10_000,
        'recipient receives the tip',
      );
      assert.equal(senderAfter - senderBefore, rent, 'sender gets the rent deposit back');
      assert.isNull(
        await provider.connection.getAccountInfo(e.pda),
        'escrow account is closed',
      );
    });

    it('refuses to pay without the attestor signature', async () => {
      const e = await createEscrow();
      // Strip the attestor's signer flag; the program declares it as Signer.
      const ix = await claimBuilder(e).instruction();
      for (const key of ix.keys) {
        if (key.pubkey.equals(e.attestor.publicKey)) key.isSigner = false;
      }
      const tx = new Transaction().add(ix);
      await rejectsWith(
        provider.sendAndConfirm(tx, [e.recipient]),
        'privilege escalation',
      );
    });

    it('refuses an attestor that is not the one recorded on the escrow', async () => {
      const e = await createEscrow();
      const impostor = Keypair.generate();
      await fund(impostor.publicKey, 1);
      await rejectsWith(
        claimBuilder(e, { attestor: impostor.publicKey })
          .signers([e.recipient, impostor])
          .rpc(),
        'ConstraintHasOne',
      );
    });

    it('refuses to pay without the recipient signature', async () => {
      const e = await createEscrow();
      const ix = await claimBuilder(e).instruction();
      for (const key of ix.keys) {
        if (key.pubkey.equals(e.recipient.publicKey)) key.isSigner = false;
      }
      const tx = new Transaction().add(ix);
      await rejectsWith(provider.sendAndConfirm(tx, [e.attestor]), 'privilege escalation');
    });

    it('refuses a second claim on the same escrow', async () => {
      const e = await createEscrow();
      await claimBuilder(e).signers([e.recipient, e.attestor]).rpc();
      await rejectsWith(
        claimBuilder(e).signers([e.recipient, e.attestor]).rpc(),
        'AccountNotInitialized',
      );
    });

    it('refuses a sender account that is not the one recorded on the escrow', async () => {
      const e = await createEscrow();
      const thief = Keypair.generate();
      // Try to redirect the rent refund to an account we control.
      const ix = await program.methods
        .claim()
        .accounts({
          escrow: e.pda,
          sender: thief.publicKey,
          recipient: e.recipient.publicKey,
          attestor: e.attestor.publicKey,
        })
        .instruction();
      const tx = new Transaction().add(ix);
      await rejectsWith(provider.sendAndConfirm(tx, [e.recipient, e.attestor]), 'ConstraintSeeds');
    });

    /**
     * Documents a deliberate limit of the on-chain design. The program does not
     * — and cannot — know which wallet belongs to X user N, so `claim` does not
     * check the recipient against recipient_x_hash. That binding is the
     * attestor's whole job, which is why the attestor signature is mandatory
     * above. If this assertion ever starts failing, someone has added an
     * on-chain identity check and this test should be rewritten, not deleted.
     */
    it('lets the attestor authorise any recipient, by design', async () => {
      const e = await createEscrow();
      const other = Keypair.generate();
      await fund(other.publicKey, 1);

      await claimBuilder(e, { recipient: other.publicKey })
        .signers([other, e.attestor])
        .rpc();

      assert.isNull(await provider.connection.getAccountInfo(e.pda));
    });
  });

  describe('refund', () => {
    it('refuses a refund before the escrow expires', async () => {
      const e = await createEscrow();
      await rejectsWith(
        program.methods
          .refund()
          .accounts({ escrow: e.pda, sender: e.sender.publicKey })
          .signers([e.sender])
          .rpc(),
        'NotYetExpired',
      );
    });

    it('refuses a refund to anyone but the sender', async () => {
      const e = await createEscrow();
      const thief = Keypair.generate();
      await fund(thief.publicKey, 1);
      await rejectsWith(
        program.methods
          .refund()
          .accounts({ escrow: e.pda, sender: thief.publicKey })
          .signers([thief])
          .rpc(),
        'ConstraintSeeds',
      );
    });

    it('returns everything to the sender once expired', async () => {
      // Shortest expiry the program will accept is "any time in the future",
      // so create one a few seconds out and wait for the validator clock.
      const e = await createEscrow({ expiresAt: nowSeconds() + 2 });
      const before = await provider.connection.getBalance(e.sender.publicKey);
      const escrowLamports = (await provider.connection.getAccountInfo(e.pda))!.lamports;

      await new Promise((r) => setTimeout(r, 8000));

      await program.methods
        .refund()
        .accounts({ escrow: e.pda, sender: e.sender.publicKey })
        .signers([e.sender])
        .rpc();

      const after = await provider.connection.getBalance(e.sender.publicKey);
      assert.approximately(
        after - before,
        escrowLamports,
        10_000,
        'sender recovers the tip and the rent',
      );
      assert.isNull(await provider.connection.getAccountInfo(e.pda));
    });

    it('refuses a refund after the tip was already claimed', async () => {
      const e = await createEscrow({ expiresAt: nowSeconds() + 2 });
      await claimBuilder(e).signers([e.recipient, e.attestor]).rpc();
      await new Promise((r) => setTimeout(r, 8000));
      await rejectsWith(
        program.methods
          .refund()
          .accounts({ escrow: e.pda, sender: e.sender.publicKey })
          .signers([e.sender])
          .rpc(),
        'AccountNotInitialized',
      );
    });
  });

  describe('isolation between escrows', () => {
    it('keeps two escrows from the same sender independent', async () => {
      const sender = Keypair.generate();
      const attestor = Keypair.generate();
      await fund(sender.publicKey);
      await fund(attestor.publicKey, 1);

      const hash = xHash('777');
      const first = nonceBN();
      const second = nonceBN();
      const pdaA = pdaFor(sender.publicKey, hash, first);
      const pdaB = pdaFor(sender.publicKey, hash, second);

      for (const [pda, nonce] of [
        [pdaA, first],
        [pdaB, second],
      ] as const) {
        await program.methods
          .createEscrow(Array.from(hash), TIP, nonce, new anchor.BN(nowSeconds() + DAY))
          .accounts({
            escrow: pda,
            sender: sender.publicKey,
            attestor: attestor.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([sender])
          .rpc();
      }

      const recipient = Keypair.generate();
      await fund(recipient.publicKey, 1);
      await program.methods
        .claim()
        .accounts({
          escrow: pdaA,
          sender: sender.publicKey,
          recipient: recipient.publicKey,
          attestor: attestor.publicKey,
        })
        .signers([recipient, attestor])
        .rpc();

      assert.isNull(await provider.connection.getAccountInfo(pdaA));
      assert.isNotNull(
        await provider.connection.getAccountInfo(pdaB),
        'claiming one escrow must not touch the other',
      );
    });
  });
});
