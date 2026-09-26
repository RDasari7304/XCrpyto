# Deploying

## Read this first

Ship to **devnet**, not mainnet. Devnet gives you the real thing — real X OAuth,
real Phantom, a real public URL, real transactions on a real chain — with
worthless SOL. Every bug you're about to find costs nothing to find there.

Two hard blockers stand between this and mainnet:

1. **The escrow program has never been compiled.** Not built, not deployed, not
   one of its 17 tests executed. So this deploy runs with `ESCROW_ENABLED=false`:
   tips to registered recipients work, and the bot tells senders to invite
   anyone else. Do not set that flag to `true` until the program builds, its
   tests pass, and someone else has reviewed it.
2. **Money transmission.** Non-custodial removes the clearest exposure, but the
   identity-oracle role is unusual and how a given escrow design is treated is
   fact-specific. I'm not a lawyer. Talk to a fintech lawyer before real money.

Also: reading the bot's mentions needs a **paid X API tier**. The free tier is
write-only. Without it, the worker can't see mentions — sign-in and the
approval flow still work, so deploy first and add the worker when you have
access.

---

## What you need

- A GitHub repo with this code pushed
- An X developer app (OAuth 2.0, confidential client)
- A host. Steps below use **Render** because the blueprint is committed; Fly.io
  and Railway work the same way

## 1. Push to GitHub

```bash
cd ~/xcrypto
git init
git add .
git commit -m "XLedger: non-custodial X tipping"
git branch -M main
git remote add origin git@github.com:<you>/xcrypto.git
git push -u origin main
```

Check `.env` is **not** in that commit:

```bash
git ls-files | grep -c '\.env$'    # must print 0
```

If it printed 1, remove it before pushing anywhere public — it has your session
pepper in it.

## 2. Create the X app

At <https://developer.x.com> → your project → an app with **OAuth 2.0** enabled.

- App type: **Web App** (confidential client)
- Callback URL: `https://<your-domain>/auth/callback` — exact, no trailing slash
- Website URL: `https://<your-domain>`
- Scopes: `tweet.read`, `users.read`

Save the **Client ID** and **Client Secret**. You won't see the secret again.

You don't know your domain yet, so come back and fix the callback after step 3.

For the bot account (only needed for the mention worker): log in as the bot,
generate a user-context access token with `tweet.read`, `tweet.write`,
`users.read`. Get its numeric id from `https://api.x.com/2/users/me`.

Mark the bot account as automated in its X profile settings. X requires
automated accounts to be labelled.

## 3. Deploy on Render

1. Render dashboard → **New** → **Blueprint** → connect your repo. It reads
   `render.yaml` and creates a web service, a worker, and a Postgres database.
2. The first deploy will fail — `BASE_URL` isn't set yet. Expected.
3. Copy your service URL (`https://xcrypto-xxxx.onrender.com`).
4. On **both** services → Environment, set:

   | Key | Value |
   |---|---|
   | `BASE_URL` | `https://xcrypto-xxxx.onrender.com` |
   | `WEB_ORIGIN` | the same URL |
   | `X_CLIENT_ID` | from step 2 |
   | `X_CLIENT_SECRET` | from step 2 |
   | `X_BOT_HANDLE` | your bot's handle, no `@` |
   | `X_BOT_TOKEN` | bot token, or leave blank for now |
   | `X_BOT_USER_ID` | bot numeric id, or blank |

   `BASE_URL` and `WEB_ORIGIN` are the same value because the API serves the
   frontend from the same origin. That's deliberate: one origin means no CORS
   and no third-party-cookie problems.

5. Go back to your X app and set the callback to
   `https://xcrypto-xxxx.onrender.com/auth/callback`.
6. Redeploy.

## 4. Create the tables

Render → your web service → **Shell**:

```bash
npm run migrate
```

Expect `Schema applied.` Run this again after any deploy that changes
`db/schema.sql` — it's written to be safely re-runnable.

## 5. Check it

```
https://<your-domain>/health          -> {"ok":true}
```

Then open the site, click **Sign in with X**, authorise, and you should land on
the dashboard as your real handle. Logs should show
`escrow: disabled (direct tips only)`.

## 6. End-to-end test on devnet

You need two X accounts and two Phantom wallets — the second can be a fresh
Phantom profile in another browser.

1. Switch both Phantoms to **Devnet** (Settings → Developer Settings → Change
   Network → Devnet).
2. Fund both. The web faucet at <https://faucet.solana.com> is the easiest, or
   locally: `solana airdrop 2 <address> --url devnet`.
3. Sign in as account A, connect wallet A, **Prove ownership**.
4. Sign in as account B in the other browser, connect wallet B, prove it too.
   Both must do this — direct tips only work to a registered recipient.
5. With the worker running, reply to any post from account A:
   `@YourBot send 0.1 sol to @accountB`. Without paid API access, use the shell
   instead: `npm run seed -- <A's handle> 0.1 --direct`.
6. Open the approval link, check the amount and destination, sign in Phantom.
7. Verify on <https://explorer.solana.com/?cluster=devnet> with the signature.

## 7. Custom domain

Render → Settings → Custom Domain. Then update `BASE_URL`, `WEB_ORIGIN`, and
the X callback URL to match, and redeploy. All three must agree or sign-in
breaks.

---

## Before mainnet

Everything above is a devnet deploy. For real money, in rough order:

1. **Build and test the escrow program.** `anchor build`, `anchor test`, all 17
   passing. Then get it reviewed by someone who writes Solana programs.
2. **Independent audit** of the program. It holds strangers' funds.
3. **Attestor key into a KMS**, not an env var. It can't steal funds, but a
   compromise lets someone stall claims until refund windows open.
4. **A second attestor** with a 1-of-2 check, closing that stalling vector.
5. **A paid RPC endpoint.** The public devnet/mainnet RPCs are rate-limited and
   will drop transactions under any real load. Helius, Triton, QuickNode.
6. **Error tracking and alerting.** Sentry or equivalent, plus an alert on
   failed sign-ins and failed transaction confirmations.
7. **Tighten the tip ceiling.** `MAX_TIP_LAMPORTS` defaults to 5 SOL. Start
   lower.
8. **Legal review**, per the top of this file.
9. **Rotate `SESSION_PEPPER`** if it was ever in a file you committed. Rotating
   it logs everyone out, which is the point.

## Operational notes

- **Two processes.** The web service serves the API and the frontend; the worker
  polls mentions. The worker is optional — without it, sign-in and approval
  links work, only mention-triggered tips don't.
- **Poll interval vs API quota.** The worker polls every 20s, roughly 130k
  requests/month. Check your X tier's read cap and raise the interval in
  `src/workers.ts` if needed.
- **Never run two workers.** Both would read the same mentions. The cursor in
  `poll_state` isn't locked, so duplicate proposals could be created. Keep the
  worker at one instance.
- **`ALLOW_DEV_LOGIN` must not be set in production.** `NODE_ENV=production`
  already disables the route, and the server refuses to boot if the flag is set
  with a non-local `BASE_URL` — but don't rely on that. Leave it unset.
- **Free tiers sleep.** On Render's free plan the service idles out and the
  worker stops polling. Use a paid instance for anything continuous.
