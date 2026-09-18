# XCrypto — non-custodial SOL tipping on X

Reply to a post with `@XCryptoBot send 5 sol to this user`. The bot builds a
transaction and sends you a link. You sign it in your own wallet. XCrypto never
holds your SOL and has no key that can spend it.

## What changed from the first draft

The first version was a pooled treasury wallet with server-side balances — the
architecture that creates the custody and money-transmission problem. It's gone.
There is no balance column in the schema now, because the app never owes anyone
anything.

| | Custodial (removed) | Non-custodial (this) |
|---|---|---|
| Who holds the SOL | app's treasury wallet | the user's wallet, or a program PDA |
| What a tip is | a database row update | a transaction the sender signs |
| App's keys | could spend every user's funds | can't move a lamport |
| Recipient not registered | app holds it in the pool | on-chain escrow, refundable to sender |

## Flow

```
@XCryptoBot send 5 SOL to @alice
          │
          ▼
   mention poller parses the command      ← nothing moves yet
          │
          ▼
   does @alice have a verified wallet?
        ╱                      ╲
      yes                       no
       │                         │
 build SystemProgram      build create_escrow
   .transfer ix               instruction
        ╲                      ╱
          ▼                  ▼
   bot replies with /approve/<id>
          │
          ▼
   sender opens it, reviews the amount and
   destination, signs in Phantom/Solflare
          │
          ▼
   transaction lands. Server verifies it on
   chain before marking the tip confirmed.
```

### Unregistered recipients

The sender's SOL goes into a program-owned PDA, seeded with
`["escrow", sender, sha256(x_user_id), nonce]`. Two exits, both enforced by the
program in `programs/xcrypto-escrow/src/lib.rs`:

- **claim** — requires the recipient's wallet signature **and** the attestor's.
  The attestor is an identity oracle: it asserts "this wallet belongs to X user
  N" and nothing more. It can't redirect the funds, because the recipient must
  also sign and is the only account that can receive.
- **refund** — after 30 days the sender takes it back, no attestation needed. So
  if XCrypto disappears tomorrow, nobody's SOL is stranded.

The X id is hashed before it goes on-chain, so the chain doesn't publish a list
of which X accounts have unclaimed tips waiting.

## Security

What's implemented, and why:

- **Session cookies** are `httpOnly` + `SameSite=Lax` + `Secure` in production,
  and the database stores only a peppered SHA-256 of the token — a database dump
  doesn't hand over live sessions.
- **CSRF** double-submit token compared with `timingSafeEqual`, on top of Lax.
- **CORS** is a strict single-origin allowlist; credentials go nowhere else.
- **Wallet ownership** is proved by signing a challenge bound to the domain, the
  X user id and a single-use nonce that's consumed whether or not it verifies.
  One wallet maps to one X account, so two accounts can't fight over an address.
- **Transactions are built server-side** from the server's own record. The
  recipient address never comes from the request body, so a tampered client
  can't redirect a tip.
- **Confirmation is verified against the chain**, not the client's word: the
  server checks the destination's balance actually rose by the promised amount.
- **Idempotency** on `source_tweet_id`, so a replayed mention can't create a
  second proposal.
- **Intents expire** in 30 minutes, so a stale approval link is dead.
- **Rate limits** live in Postgres (per user, per IP, per X account), so they
  survive restarts and multiple nodes.
- **Headers**: `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, HSTS in prod,
  and a `default-src 'none'` CSP on the JSON API.
- **Amounts** are strings parsed to `BigInt` lamports. No float touches money.
- **X scopes** are `tweet.read users.read` only. The app never posts through a
  user's account, which keeps it clear of X's consent rules for automated
  actions on someone's behalf. The bot replies from its own clearly-labelled
  automated account.

Still to do before mainnet:

1. **Audit the escrow program.** The test suite in `tests/xcrypto-escrow.ts`
   covers the refusals (see "Testing the escrow" below), but tests only prove
   the failures you thought of. It's ~180 lines and the logic is simple, and
   it's still the only thing between a user's SOL and a bug. Get it reviewed.
2. **Attestor key into a KMS/HSM.** It can't move funds, but it can be a
   griefing vector — see the residual risk below.
3. **Residual attestor risk**: a compromised attestor could refuse to co-sign
   claims. Funds aren't lost (refund path is unconditional after expiry), but
   recipients would be stuck waiting. Consider a second attestor and a 1-of-2
   check, or an expiry short enough that stalling is cheap.
4. **Reading the bot's mentions needs a paid X API tier** — the free tier is
   write-only. This polls `GET /2/users/:id/mentions` rather than the filtered
   stream because it sits lower in the pricing tiers. At a 20s interval that's
   roughly 130k requests/month; check your read quota and tune the interval.
5. **Handle impersonation.** Handles are resolved to numeric X ids at parse
   time, and the approval screen shows the destination address, so a lookalike
   handle can't silently farm tips. Consider also showing the recipient's
   numeric id.
6. **Legal.** Non-custodial removes the clearest money-transmission exposure,
   but it doesn't make the question go away by itself — how a particular escrow
   design is treated is fact-specific, and the identity-oracle role is unusual
   enough to be worth asking about. I'm not a lawyer; have a fintech lawyer look
   at the escrow design before mainnet.

## Testing the escrow

```bash
npm install
anchor test          # spins up its own validator, deploys, runs the suite
```

If you already have `solana-test-validator` running, use `anchor test
--skip-local-validator` instead.

The suite is written adversarially — almost every case asserts that something is
*refused*:

| | |
|---|---|
| `create_escrow` | holds tip + rent in a program-owned PDA; rejects zero amounts, past expiries, expiries past the 90-day ceiling, and reuse of an existing PDA |
| `claim` | pays the recipient and returns rent to the sender; rejects a missing attestor signature, a wrong attestor, a missing recipient signature, a second claim, and a substituted sender account |
| `refund` | rejects before expiry, rejects anyone but the sender, returns tip + rent once expired, rejects after an earlier claim |
| isolation | claiming one escrow leaves a sibling escrow from the same sender untouched |

One test asserts a *limitation* rather than a guarantee:
`lets the attestor authorise any recipient, by design`. The program cannot know
which wallet belongs to X user N, so `claim` does not check the recipient
against `recipient_x_hash` — that binding is the attestor's entire job, which is
why its signature is mandatory. If that test ever starts failing, someone has
added an on-chain identity check; rewrite the test rather than deleting it.

The two refund tests wait ~8s for the validator clock to pass a short expiry, so
the suite takes about half a minute.

---

# Running it locally

For a full step-by-step test pass, use `RUNBOOK.md` instead — it covers the
frontend, the backend, the end-to-end flow and the program tests in order,
without needing an X developer account.

On Windows, use `RUNBOOK-WSL.md`: `solana-test-validator` and Anchor are not
available for native Windows, so the project runs under WSL2. It includes the
one-time WSL setup.

You need Node 20+, Postgres 14+, Rust with the Solana CLI and Anchor, and
Phantom or Solflare in your browser.

### 1. Database

```bash
createdb xcrypto
```

### 2. Local Solana validator (leave this running)

```bash
solana-test-validator --reset
```

In another terminal:

```bash
solana config set --url localhost
solana-keygen new          # if you don't have a keypair yet
solana airdrop 10
```

### 3. Deploy the escrow program

```bash
cd xcrypto
anchor build
anchor deploy               # prints "Program Id: <PROGRAM_ID>"
```

Take that program id and put it in **both** `Anchor.toml` (under
`[programs.localnet]`) and `declare_id!()` in
`programs/xcrypto-escrow/src/lib.rs`, then `anchor build && anchor deploy` again.
Anchor bakes the id into the binary, so the first deploy's id won't match until
you do this once.

### 4. Backend

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm run keys             # prints SESSION_PEPPER and ATTESTOR_SECRET_KEY — paste into .env
npm run migrate
```

Fill in the rest of `.env`:

- `ESCROW_PROGRAM_ID` — from step 3
- `X_CLIENT_ID` / `X_CLIENT_SECRET` — from developer.x.com, OAuth 2.0
  confidential client, callback exactly `http://localhost:3000/auth/callback`
- `X_BOT_TOKEN` / `X_BOT_USER_ID` — your bot account's token and numeric id

Fund the attestor so it can act as a signer:

```bash
solana airdrop 1 <attestor-pubkey-printed-by-npm-run-keys>
```

Then:

```bash
npm run api          # http://localhost:3000
```

### 5. Frontend

```bash
cd web
npm install
cp .env.example .env
echo "VITE_RPC_URL=http://127.0.0.1:8899" >> .env
npm run dev
```

**Open http://localhost:5173.**

### 6. Point your wallet at localnet

In Phantom: Settings → Developer Settings → Change Network → Localhost. Then
airdrop yourself some SOL:

```bash
solana airdrop 5 <your-phantom-address>
```

### 7. Try it without touching X

The mention poller needs paid X API access, so for local testing skip it. Sign
in without an X app, then create a tip intent directly:

```bash
# .env ships with ALLOW_DEV_LOGIN=true, which enables this route locally only
open http://localhost:3000/auth/dev-login?handle=devuser

# connect and verify a wallet on the dashboard, then:
npm run seed -- devuser 0.25            # escrow route
npm run seed -- devuser 0.1 --direct    # direct route
```

Each prints an `/approve/<id>` URL to open and sign. To test claiming, point a
funded escrow at your own account with `npm run claimable -- devuser`.

Once you have X API access, run the poller in a third terminal:

```bash
npm run workers
```
