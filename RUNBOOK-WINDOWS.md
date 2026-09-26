# Test runbook — Windows (cmd)

Same 25 steps as `RUNBOOK.md`, with commands that work in Command Prompt.
Terminals are numbered — keep the long-running ones open.

**Prerequisites:** Node 20+, PostgreSQL 14+, Rust, Solana CLI, Anchor 0.30, and
Phantom or Solflare in your browser. No X developer account needed.

Two notes before you start:

- `createdb`, `psql`, `solana` and `anchor` must be on your `PATH`. The
  Postgres installer does not add its `bin` folder by default — if
  `createdb` isn't recognised, add `C:\Program Files\PostgreSQL\16\bin` to
  your PATH and open a new terminal.
- **`solana-test-validator` and Anchor do not exist for native Windows.** Parts
  B, C and D cannot run in cmd at all. Use `RUNBOOK-WSL.md` instead — it covers
  WSL2 setup from scratch and then the whole test pass. Part A below (frontend
  only) does work natively, but running everything in WSL is simpler.

---

## Part A — Frontend on its own

The frontend runs standalone. With no backend up you land on the marketing
page, which is what a first-time visitor sees.

**1.** Install and start it. **Terminal 1**, leave running.

```bat
cd xcrypto\web
npm install
copy .env.example .env
echo VITE_RPC_URL=http://127.0.0.1:8899>> .env
npm run dev
```

No quotes around the `echo` value — `cmd` would write them into the file.

### If `npm install` fails in `web`

If you see an error mentioning `@stellar/stellar-sdk` and
`yarn setup || true`, you have an older copy of `web/package.json` that depends
on `@solana/wallet-adapter-wallets`. That meta-package pulls in an adapter for
every wallet in existence, and one of them has a `yarn`-only install script that
cannot run in `cmd`. The fix is already applied here: only
`@solana/wallet-adapter-phantom` and `@solana/wallet-adapter-solflare` are
installed. Clear the partial install and retry:

```bat
cd xcrypto\web
rmdir /s /q node_modules
del package-lock.json
npm install
```

To add another wallet later, install that adapter by name rather than the
meta-package.

**2.** Open **http://localhost:5173**.

You should see "Tip anyone on X in SOL", a "Where your SOL sits" slip ending in
*Ever held by XLedger — Never*, and a "Sign in with X" button.

**3.** Check the easy-to-break things.

- Narrow the window to phone width — the column stays readable, nothing scrolls
  sideways.
- Press Tab repeatedly — every link and button shows a blue focus ring.
- Click "Sign in with X" — it fails, because there's no backend yet. Expected.

**4.** Check the approval screen's error path.

Visit **http://localhost:5173/approve/00000000-0000-0000-0000-000000000000**.
You should get "Can't open this request", not a blank page or a spinner that
never resolves.

---

## Part B — Backend, database and program

**5.** Create the database.

```bat
createdb -U postgres xcrypto
```

It will prompt for the password you set during installation. If `createdb`
isn't found, use:

```bat
psql -U postgres -c "CREATE DATABASE xcrypto"
```

**6.** Start a local validator. **Terminal 2**, leave running.

```bat
solana-test-validator --reset
```

**7.** **Terminal 3** — point the CLI at it and fund yourself.

```bat
solana config set --url localhost
solana-keygen new
solana airdrop 10
```

Skip `solana-keygen new` if you already have a keypair.

**8.** Build and deploy the escrow program.

```bat
cd xcrypto
npm install
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/xcrypto_escrow-keypair.json
anchor keys sync
anchor build
anchor deploy
```

`anchor deploy` prints `Program Id: <ID>`.

**9.** Confirm the program id was written correctly.

```bat
anchor keys list
```

`anchor keys sync` in step 8 wrote the generated id into `declare_id!()` and
into `Anchor.toml`. If you see `Error: String is the wrong size`, those two have
drifted from `target/deploy/xcrypto_escrow-keypair.json` — run
`anchor keys sync` again.

**10.** Generate local secrets.

```bat
copy .env.example .env
npm run keys
```

Open `.env` in an editor (`notepad .env`) and fill in:

- `SESSION_PEPPER` and `ATTESTOR_SECRET_KEY` — from `npm run keys`
- `ESCROW_PROGRAM_ID` — the id from step 9
- `DATABASE_URL` — change `postgres:postgres` to your actual Postgres
  password, e.g. `postgres://postgres:yourpassword@localhost:5432/xcrypto`

`ALLOW_DEV_LOGIN=true` is already there, which is what lets you sign in without
an X app. Leave the four `X_*` values blank — nothing in this runbook reads them.

**11.** Fund the attestor so it can sign.

```bat
solana airdrop 1 <attestor-pubkey-printed-by-npm-run-keys>
```

**12.** Create the tables.

```bat
npm run migrate
```

**13.** Start the API. **Terminal 4**, leave running.

```bat
npm run api
```

You should see `API on :3000`, the attestor pubkey, and a `DEV LOGIN ENABLED`
warning. That warning is correct here — and is your signal that this config must
never ship.

**14.** Confirm it's alive. Back in **terminal 3**:

```bat
curl http://localhost:3000/health
curl -i http://localhost:3000/api/me
```

Expect `{"ok":true}` then a 401. The 401 is the auth gate working.

---

## Part C — The full flow

**15.** Point your wallet at localnet.

Phantom: Settings → Developer Settings → Change Network → Localhost. Then:

```bat
solana airdrop 5 <your-wallet-address>
```

**16.** Sign in.

Open **http://localhost:3000/auth/dev-login?handle=devuser**. You land on the
dashboard showing `@devuser`.

**17.** Link your wallet.

Click the wallet button, connect Phantom, click **Prove ownership**. Phantom
shows a message-signing prompt — read it, it names the domain, your handle and a
nonce, and says it authorises no transfer. Approve.

The header changes to "Tips settle to <your address> on localnet".

**18.** Test the escrow route — a tip to someone who hasn't joined.

```bat
npm run seed -- devuser 0.25
```

Open the printed `/approve/<id>` URL. Check it reads **0.25 SOL**, the
destination says *An escrow only they can open*, and the 30-day refund note is
there. Click **Send 0.25 SOL** and approve in Phantom.

The page flips to "Sent" with a signature. Verify on chain:

```bat
solana confirm -v <signature>
```

**19.** Confirm the escrow holds it.

On the dashboard the tip appears under **Sent** as *held in escrow*, and your
wallet is down ~0.25 SOL plus rent and fees.

**20.** Test the direct route — a tip to someone registered.

```bat
npm run seed -- devuser 0.1 --direct
```

Open the new approve URL. This time it shows **Their wallet** with a truncated
address instead of the escrow line. Sign it. The SOL goes straight to the
recipient with no escrow in between.

**21.** Test claiming.

Step 18 addressed its escrow to a stand-in, so repoint it at your account:

```bat
npm run claimable -- devuser
```

Reload the dashboard. The tip appears under **Tips waiting for you to claim** in
amber. Click **Claim** and approve in Phantom. Your balance goes back up by
0.25 SOL and the row disappears.

That claim needed two signatures — the attestor's, added server-side, and yours.
Neither alone could move it.

**22.** Verify the security properties by hand.

In the browser console on localhost:5173:

```js
document.cookie          // must NOT contain "sid"
```

In **terminal 3**:

```bat
curl -i -X POST http://localhost:3000/api/wallet/challenge
```

Expect 403 — no CSRF header. Then the rate limiter:

```bat
for /l %i in (1,1,15) do @curl -s -o NUL -w "%%{http_code} " -X POST http://localhost:3000/api/wallet/challenge
```

Expect a run of 403s that turns into 429s. In a `.bat` file, double the `%i`
to `%%i`.

---

## Part D — Escrow program tests

**23.** Run the suite. Anchor starts its own validator, so either reuse
terminal 2's or stop it first.

```bat
cd xcrypto
anchor test --skip-local-validator
```

**24.** Check the output.

17 passing in about 30 seconds, in four groups: `create_escrow`, `claim`,
`refund`, `isolation between escrows`. Two refund tests sleep ~8s waiting for
the validator clock to pass a short expiry, so a pause there is expected, not a
hang.

**25.** Prove the tests can fail.

In `programs\xcrypto-escrow\src\lib.rs`, comment out the expiry check in
`refund`:

```rust
// require!(now >= ctx.accounts.escrow.expires_at, EscrowError::NotYetExpired);
```

Run `anchor test` again. `refuses a refund before the escrow expires` should
fail. Put the line back and confirm it passes.

---

## Cleanup

```bat
dropdb -U postgres xcrypto
```

Then Ctrl-C terminals 1, 2 and 4. Validator chain state lives in
`test-ledger\`; `--reset` clears it.

## Before this leaves your laptop

Set `NODE_ENV=production` and remove `ALLOW_DEV_LOGIN` from the environment.
The dev-login route is a complete authentication bypass by design — gated
twice, but the only safe configuration is for it to be absent. See "Before
mainnet" in `README.md` for the rest.

---

## Command translations, for reference

| Unix | Windows cmd |
|---|---|
| `cp a b` | `copy a b` |
| `echo "X" >> f` | `echo X>> f` (no quotes) |
| `export V=x` | `set V=x` |
| `$VAR` | `%VAR%` |
| `rm -rf d` | `rmdir /s /q d` |
| `cat f` | `type f` |
| `/dev/null` | `NUL` |
| `for i in $(seq 1 15)` | `for /l %i in (1,1,15) do` |
| `nano f` | `notepad f` |

PowerShell aliases `cp`, `cat` and `rm`, so those three work there — but `$VAR`
and the `for` loop still differ, which is why `npm run migrate` is now a Node
script rather than a `psql` one-liner.
