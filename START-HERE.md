# XLedger

Non-custodial SOL tipping on X. Reply to a post with
`@XLedger_Bot send 5 sol to this user`; the bot builds a transaction and sends you
a link; you sign it in your own wallet. XLedger never holds anyone's SOL and has
no key that can spend it.

## Which document do you want

| You want to | Read |
|---|---|
| Understand how it works and why | `README.md` |
| Put it online and test with a real X account | `DEPLOY.md` |
| Run and test it locally on Linux or macOS | `RUNBOOK.md` |
| Run and test it locally on Windows | `RUNBOOK-WSL.md` |

`RUNBOOK-WINDOWS.md` exists for reference, but `solana-test-validator` and
Anchor don't run on native Windows, so `RUNBOOK-WSL.md` is the real path there.

## Current state

Working: X OAuth sign-in, wallet ownership proof, mention parsing, tip
proposals, the approval-and-sign flow, on-chain verification of what landed.

**Not working: the escrow program has never been compiled.** It's written
(`programs/xcrypto-escrow/src/lib.rs`) and has a 17-test suite
(`tests/xcrypto-escrow.ts`), but neither has ever run — we never got the Rust
toolchain working. So the app ships with `ESCROW_ENABLED=false`, which means
tips to registered recipients work and the bot asks senders to invite anyone
else.

Do not set `ESCROW_ENABLED=true` until that program builds, its tests pass, and
somebody who writes Solana programs has reviewed it. It would be holding
strangers' funds.

## Layout

```
src/            API, mention worker, tip intents, security
db/schema.sql   Postgres schema (no balance columns — nothing is owed to anyone)
web/            React frontend (Vite)
programs/       Anchor escrow program (unbuilt)
tests/          Escrow test suite (never run)
scripts/        migrate, keygen, local seeding
Dockerfile      Production image
render.yaml     Render blueprint: web + worker + Postgres
```

## Quickest path to seeing it work

`DEPLOY.md`, deploying to devnet. Real X login, real Phantom, real chain,
worthless SOL. It sidesteps the entire local toolchain problem.
