# Setup and test runbook — WSL2 (recommended on Windows)

`solana-test-validator` and Anchor are not available for native Windows. Run
the whole project inside WSL2 instead. Your Windows browser and Phantom work
unchanged, because WSL2 forwards `localhost` ports to Windows automatically.

This also sidesteps the `@stellar/stellar-sdk` install failure: that package's
script is `yarn setup || true`, and `true` is a real command on Linux, so the
fallback works.

Part 0 is one-time setup. Parts A–D are the same test pass as `RUNBOOK.md`.

---

## Part 0 — One-time setup

**1.** Install WSL2. In an **Administrator** PowerShell or cmd:

```bat
wsl --install -d Ubuntu
```

Reboot if it asks. On first launch Ubuntu asks for a username and password —
this is your Linux account, unrelated to Windows. Remember the password; `sudo`
needs it.

Every command from here on runs **inside Ubuntu**. Open it from the Start menu,
or type `wsl` in any terminal.

**2.** Update and install build tools.

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential pkg-config libssl-dev libudev-dev git curl
```

**3.** Install Node 20 via nvm.

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
node --version
```

**4.** Install Postgres and start it.

```bash
sudo apt install -y postgresql
sudo service postgresql start
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres'"
sudo -u postgres createdb xcrypto
```

WSL doesn't run services at boot, so after each Windows restart you need
`sudo service postgresql start` again.

**5.** Install Rust.

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
rustc --version
```

**6.** Install the Solana CLI.

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
solana --version
```

**7.** Install Anchor.

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.30.1
avm use 0.30.1
anchor --version
```

This compiles from source and takes 10–20 minutes. Normal.

**8.** Copy the project into the Linux filesystem.

Your Windows files are visible at `/mnt/c/`, but building there is slow and
file-watching is unreliable. Copy it across:

```bash
cp -r "/mnt/c/Users/Rohit Dasari/xcrypto" ~/xcrypto
cd ~/xcrypto
rm -rf node_modules web/node_modules
```

Work in `~/xcrypto` from now on. To edit files with Windows tools, VS Code with
the WSL extension opens `~/xcrypto` directly; or reach it from Explorer at
`\\wsl$\Ubuntu\home\<your-linux-username>\xcrypto`.

---

## Part A — Frontend on its own

**9.** Install and start it. **Terminal 1**, leave running.

```bash
cd ~/xcrypto/web
npm install
cp .env.example .env
echo "VITE_RPC_URL=http://127.0.0.1:8899" >> .env
npm run dev
```

The install should now finish cleanly.

**10.** Open **http://localhost:5173** in your Windows browser.

You should see "Tip anyone on X in SOL", a "Where your SOL sits" slip ending in
*Ever held by XLedger — Never*, and a "Sign in with X" button.

**11.** Check the easy-to-break things.

- Narrow the window to phone width — the column stays readable, nothing
  scrolls sideways.
- Press Tab repeatedly — every link and button shows a blue focus ring.
- Click "Sign in with X" — it fails, there's no backend yet. Expected.

**12.** Check the approval screen's error path.

Visit **http://localhost:5173/approve/00000000-0000-0000-0000-000000000000**.
You should get "Can't open this request", not a blank page or an endless
spinner.

---

## Part B — Backend, database and program

**13.** Start a validator. **Terminal 2** (`wsl` in a new window), leave running.

```bash
solana-test-validator --reset
```

**14.** **Terminal 3** — point the CLI at it and fund yourself.

```bash
solana config set --url localhost
solana-keygen new
solana airdrop 10
```

**15.** Build and deploy the escrow program.

```bash
cd ~/xcrypto
npm install
mkdir -p target/deploy
solana-keygen new --no-bip39-passphrase -o target/deploy/xcrypto_escrow-keypair.json
anchor keys sync
anchor build
anchor deploy
```

`anchor deploy` prints `Program Id: <ID>`.

**16.** Confirm the program id was written correctly.

```bash
anchor keys list
```

`anchor keys sync` in step 15 wrote the generated id into `declare_id!()` in
`programs/xcrypto-escrow/src/lib.rs` and into `Anchor.toml`. If you ever see
`Error: String is the wrong size`, those two have drifted from
`target/deploy/xcrypto_escrow-keypair.json` — run `anchor keys sync` again.

**17.** Generate local secrets.

```bash
cp .env.example .env
npm run keys
```

Edit `.env` (`nano .env`) and fill in:

- `SESSION_PEPPER` and `ATTESTOR_SECRET_KEY` — from `npm run keys`
- `ESCROW_PROGRAM_ID` — the id from step 16

`DATABASE_URL` already matches the password set in step 4. `ALLOW_DEV_LOGIN=true`
is already there, which lets you sign in without an X app. Leave the four `X_*`
values blank.

**18.** Fund the attestor so it can sign.

```bash
solana airdrop 1 <attestor-pubkey-printed-by-npm-run-keys>
```

**19.** Create the tables.

```bash
npm run migrate
```

**20.** Start the API. **Terminal 4**, leave running.

```bash
cd ~/xcrypto && npm run api
```

Expect `API on :3000`, the attestor pubkey, and a `DEV LOGIN ENABLED` warning.
That warning is correct here — and is your signal this config must never ship.

**21.** Confirm it's alive, in **terminal 3**:

```bash
curl http://localhost:3000/health
curl -i http://localhost:3000/api/me
```

`{"ok":true}` then a 401. The 401 is the auth gate working.

---

## Part C — The full flow

**22.** Point Phantom at localnet.

In your Windows browser: Phantom → Settings → Developer Settings → Change
Network → Localhost. Then fund it from terminal 3:

```bash
solana airdrop 5 <your-wallet-address>
```

**23.** Sign in.

Open **http://localhost:3000/auth/dev-login?handle=devuser**. You land on the
dashboard showing `@devuser`.

**24.** Link your wallet.

Click the wallet button, connect Phantom, click **Prove ownership**. Phantom
shows a message-signing prompt — read it, it names the domain, your handle and a
nonce, and says it authorises no transfer. Approve.

The header changes to "Tips settle to <your address> on localnet".

**25.** Test the escrow route — a tip to someone who hasn't joined.

```bash
npm run seed -- devuser 0.25
```

Open the printed `/approve/<id>` URL. Check it reads **0.25 SOL**, the
destination says *An escrow only they can open*, and the 30-day refund note is
there. Click **Send 0.25 SOL** and approve in Phantom.

The page flips to "Sent" with a signature. Verify it on chain:

```bash
solana confirm -v <signature>
```

**26.** Confirm the escrow holds it.

On the dashboard the tip appears under **Sent** as *held in escrow*, and your
wallet is down ~0.25 SOL plus rent and fees.

**27.** Test the direct route — a tip to someone registered.

```bash
npm run seed -- devuser 0.1 --direct
```

Open the new approve URL. This time it shows **Their wallet** with a truncated
address instead of the escrow line. Sign it. The SOL goes straight to the
recipient, no escrow in between.

**28.** Test claiming.

Step 25 addressed its escrow to a stand-in, so repoint it at your account:

```bash
npm run claimable -- devuser
```

Reload the dashboard. The tip appears under **Tips waiting for you to claim** in
amber. Click **Claim** and approve in Phantom. Your balance goes back up by
0.25 SOL and the row disappears.

That claim needed two signatures — the attestor's, added server-side, and
yours. Neither alone could move it.

**29.** Verify the security properties by hand.

In the browser console on localhost:5173:

```js
document.cookie          // must NOT contain "sid"
```

In terminal 3:

```bash
curl -i -X POST http://localhost:3000/api/wallet/challenge     # 403, no CSRF header

for i in $(seq 1 15); do curl -s -o /dev/null -w "%{http_code} " \
  -X POST http://localhost:3000/api/wallet/challenge; done     # 403s, then 429
```

---

## Part D — Escrow program tests

**30.** Run the suite. Anchor starts its own validator, so reuse terminal 2's:

```bash
cd ~/xcrypto
anchor test --skip-local-validator
```

**31.** Check the output.

17 passing in about 30 seconds, across four groups: `create_escrow`, `claim`,
`refund`, `isolation between escrows`. Two refund tests sleep ~8s waiting for
the validator clock to pass a short expiry — a pause there is expected, not a
hang.

**32.** Prove the tests can fail.

In `programs/xcrypto-escrow/src/lib.rs`, comment out the expiry check in
`refund`:

```rust
// require!(now >= ctx.accounts.escrow.expires_at, EscrowError::NotYetExpired);
```

Run `anchor test` again. `refuses a refund before the escrow expires` should
fail. Put the line back and confirm it passes.

---

## Cleanup

```bash
sudo -u postgres dropdb xcrypto
```

Ctrl-C terminals 1, 2 and 4. Validator chain state lives in `test-ledger/`;
`--reset` clears it.

## After a Windows restart

WSL doesn't start services automatically:

```bash
sudo service postgresql start
```

Then restart the validator, API and frontend as above.

## Before this leaves your laptop

Set `NODE_ENV=production` and remove `ALLOW_DEV_LOGIN` from the environment.
The dev-login route is a complete authentication bypass by design — gated
twice, but the only safe configuration is for it to be absent. See "Before
mainnet" in `README.md`.
