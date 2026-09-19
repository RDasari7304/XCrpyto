# Test runbook

Every step in order. Frontend first, then the backend, then the escrow program.
Terminals are numbered — keep the long-running ones open.

**Prerequisites:** Node 20+, Postgres 14+, Rust, Solana CLI, Anchor 0.30, and
Phantom or Solflare in your browser. No X developer account needed for any of
this.

**On Windows?** Use `RUNBOOK-WINDOWS.md` instead — the commands below assume a
POSIX shell.

---

## Part A — Frontend on its own (5 min)

The frontend runs standalone. With no backend up, the session check fails and
you land on the marketing page, which is exactly what a first-time visitor sees.

**1.** Install and start it.

```bash
cd xcrypto/web
npm install
cp .env.example .env
echo "VITE_RPC_URL=http://127.0.0.1:8899" >> .env
npm run dev
```

Leave this running. This is **terminal 1**.

**2.** Open **http://localhost:5173**.

You should see the landing page: "Tip anyone on X in SOL", a "Where your SOL
sits" slip ending in *Ever held by XCrypto — Never*, and a "Sign in with X"
button.

**3.** Check the things that are easy to get wrong.

- Narrow the window to phone width — the column should stay readable, nothing
  should scroll sideways.
- Press Tab repeatedly — every link and button should show a blue focus ring.
- Click "Sign in with X" — it will fail, because there's no backend yet. Expected.

**4.** Look at the approval screen, which is the screen that matters most.

Visit **http://localhost:5173/approve/00000000-0000-0000-0000-000000000000**.
You should get "Can't open this request" rather than a blank page or a spinner
that never resolves. That's the error path working. The real version comes in
Part C.

---

## Part B — Backend, database and program (10 min)

**5.** Create the database.

```bash
createdb xcrypto
```

**6.** Start a local validator. This is **terminal 2**, leave it running.

```bash
solana-test-validator --reset
```

**7.** In **terminal 3**, point the CLI at it and fund yourself.

```bash
solana config set --url localhost
solana-keygen new          # skip if you already have a keypair
solana airdrop 10
```

**8.** Build and deploy the escrow program.

```bash
cd xcrypto
npm install
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/xcrypto_escrow-keypair.json
anchor keys sync
anchor build
anchor deploy              # prints "Program Id: <ID>"
```

**9.** Confirm the program id was written correctly.

```bash
anchor keys list
```

`anchor keys sync` in step 8 wrote the generated id into `declare_id!()` in
`programs/xcrypto-escrow/src/lib.rs` and into `Anchor.toml`. If you ever see
`Error: String is the wrong size`, those two have drifted from
`target/deploy/xcrypto_escrow-keypair.json` — run `anchor keys sync` again.

**10.** Generate local secrets.

```bash
cp .env.example .env
npm run keys
```

Paste the printed `SESSION_PEPPER` and `ATTESTOR_SECRET_KEY` into `.env`, and
put the program id from step 9 into `ESCROW_PROGRAM_ID`.

`.env.example` ships with `ALLOW_DEV_LOGIN=true`, which is what lets you sign in
without an X app. The server refuses to start if that flag is set with a
non-local `BASE_URL`, and the route doesn't exist under `NODE_ENV=production`.

Leave the four `X_*` values blank for now — nothing in this runbook reads them.

**11.** Fund the attestor so it can sign.

```bash
solana airdrop 1 <attestor-pubkey-printed-by-npm-run-keys>
```

**12.** Create the tables.

```bash
npm run migrate
```

**13.** Start the API. This is **terminal 4**, leave it running.

```bash
npm run api
```

You should see `API on :3000`, the attestor pubkey, and a `⚠ DEV LOGIN ENABLED`
warning. That warning appearing is correct here — and is your signal that this
config must never ship.

**14.** Confirm it's alive.

```bash
curl http://localhost:3000/health          # {"ok":true}
curl -i http://localhost:3000/api/me       # 401 "Sign in with X to continue"
```

The 401 is the auth gate working.

---

## Part C — The full flow (10 min)

**15.** Point your wallet at localnet.

In Phantom: Settings → Developer Settings → Change Network → Localhost. Then
fund it:

```bash
solana airdrop 5 <your-wallet-address>
```

**16.** Sign in.

Open **http://localhost:3000/auth/dev-login?handle=devuser**. You'll be
redirected to the dashboard at localhost:5173, showing `@devuser`.

**17.** Link your wallet.

Click the wallet button, connect Phantom, then click **Prove ownership**.
Phantom shows a message-signing prompt — read it, it names the domain, your X
handle and a nonce, and says it authorises no transfer. Approve it.

The header should change to "Tips settle to <your address> on localnet".

**18.** Test the escrow route — a tip to someone who hasn't joined.

In **terminal 3**:

```bash
npm run seed -- @devuser 0.25
```

Open the printed `/approve/<id>` URL. Check the amount reads **0.25 SOL**, the
destination says *An escrow only they can open*, and the note explains the
30-day refund. Click **Send 0.25 SOL** and approve in Phantom.

The page should flip to "Sent" with a signature. Verify it landed on chain:

```bash
solana confirm -v <signature>
```

**19.** Confirm the escrow actually holds the SOL.

Back on the dashboard, the tip appears under **Sent** as *held in escrow*. Your
wallet balance should be down ~0.25 SOL plus rent and fees.

**20.** Test the direct route — a tip to someone registered.

```bash
npm run seed -- @devuser 0.1 --direct
```

Open the new approve URL. This time it shows **Their wallet** with a truncated
address instead of the escrow line. Sign it. Same "Sent" result, but the SOL
went straight to the recipient's address with no escrow in between.

**21.** Test claiming.

Claiming needs an escrow addressed to *your* X account, and step 18 addressed
one to a stand-in. Repoint it:

```bash
npm run claimable -- devuser
```

Reload the dashboard. The tip now appears under **Tips waiting for you to
claim** in amber. Click **Claim** and approve in Phantom. Your balance goes back
up by 0.25 SOL, and the row disappears.

That claim required two signatures: the attestor's, added server-side, and
yours. Neither alone could move it.

**22.** Verify the security properties by hand.

```bash
# The session cookie is httpOnly — JS can't read it. In the browser console:
document.cookie          # should NOT contain "sid"

# A POST without the CSRF header is refused:
curl -i -X POST http://localhost:3000/api/wallet/challenge   # 403

# Rate limiting bites:
for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " \
  -X POST http://localhost:3000/api/wallet/challenge; done   # 403s, then 429
```

---

## Part D — Escrow program tests (1 min)

**23.** Run the suite.

Anchor starts its own validator, so stop the one in terminal 2 first — or keep
it and skip the local validator:

```bash
cd xcrypto
anchor test --skip-local-validator    # reuses terminal 2's validator
# or: anchor test                     # after stopping terminal 2
```

**24.** Check the output.

17 passing, in about 30 seconds. Two refund tests sleep ~8s each waiting for the
validator clock to pass a short expiry, so a pause there is expected, not a
hang.

You should see four groups: `create_escrow`, `claim`, `refund`, and
`isolation between escrows`. Almost every test asserts that something is
*refused* — a missing attestor signature, a wrong attestor, a missing recipient
signature, a double claim, a substituted sender, a refund before expiry.

**25.** Prove the tests can fail.

A green suite you've never seen fail tells you nothing. Break the program on
purpose — in `programs/xcrypto-escrow/src/lib.rs`, comment out the expiry check
in `refund`:

```rust
// require!(now >= ctx.accounts.escrow.expires_at, EscrowError::NotYetExpired);
```

Then `anchor test`. The test `refuses a refund before the escrow expires` should
fail. Put the line back and confirm it passes again.

---

## Cleanup

```bash
dropdb xcrypto            # wipes accounts, wallet links and intents
# Ctrl-C terminals 1, 2 and 4
```

The validator's chain state lives in `test-ledger/`; `--reset` clears it.

## Before this ever leaves your laptop

Set `NODE_ENV=production` and remove `ALLOW_DEV_LOGIN` from the environment.
The dev-login route is a complete authentication bypass by design — it is gated
twice, but the only safe configuration is for it to be absent. See the "Before
mainnet" list in `README.md` for the rest.
