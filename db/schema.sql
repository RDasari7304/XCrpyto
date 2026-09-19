-- XCrypto schema, non-custodial.
--
-- Note what is NOT here: there is no balance column anywhere. The app never
-- owes anybody anything, so there is nothing to account for. SOL lives either
-- in the user's own wallet or in a program-owned escrow PDA.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  x_user_id     TEXT NOT NULL UNIQUE,   -- numeric X id; handles get renamed and resold
  x_handle      TEXT,
  wallet        TEXT,                   -- base58 Solana pubkey the user proved control of
  wallet_verified_at TIMESTAMPTZ,
  evm_wallet    TEXT,                   -- 0x… address for Robinhood Chain (EVM)
  evm_verified_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_wallet_idx ON users(wallet) WHERE wallet IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_wallet TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS evm_verified_at TIMESTAMPTZ;

-- Sessions store only a hash of the cookie token, so a database dump does not
-- hand over live sessions.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  -- Relative path to return to after sign-in (validated server-side, so it
  -- cannot be used as an open redirect).
  next          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent for existing databases.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS next TEXT;

-- One-shot challenges for proving wallet ownership.
CREATE TABLE IF NOT EXISTS wallet_nonces (
  nonce       TEXT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A tip the bot understood but has NOT executed. It is an unsigned proposal
-- until the sender approves it in their own wallet.
CREATE TABLE IF NOT EXISTS tip_intents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id     BIGINT NOT NULL REFERENCES users(id),
  recipient_x_user_id TEXT NOT NULL,
  recipient_x_handle TEXT,
  recipient_wallet   TEXT,              -- set only when the recipient is registered
  lamports           BIGINT NOT NULL CHECK (lamports > 0),  -- base units of the token
  token_symbol       TEXT NOT NULL DEFAULT 'SOL',
  token_mint         TEXT,              -- null for native SOL
  chain              TEXT NOT NULL DEFAULT 'solana',  -- solana | robinhood
  route              TEXT NOT NULL,     -- direct | escrow
  status             TEXT NOT NULL DEFAULT 'awaiting_approval',
                                        -- awaiting_approval | submitted | confirmed | expired | cancelled
  escrow_nonce       BIGINT,
  escrow_pda         TEXT,
  tx_signature       TEXT,
  source_tweet_id    TEXT UNIQUE,       -- idempotency: one tweet, one intent
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  confirmed_at       TIMESTAMPTZ
);
ALTER TABLE tip_intents ADD COLUMN IF NOT EXISTS token_symbol TEXT NOT NULL DEFAULT 'SOL';
ALTER TABLE tip_intents ADD COLUMN IF NOT EXISTS token_mint TEXT;
ALTER TABLE tip_intents ADD COLUMN IF NOT EXISTS chain TEXT NOT NULL DEFAULT 'solana';
CREATE INDEX IF NOT EXISTS intents_sender_idx ON tip_intents(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS intents_recipient_idx ON tip_intents(recipient_x_user_id)
  WHERE route = 'escrow';

-- Mirror of on-chain escrows, so a recipient can be shown what is waiting.
-- The chain is the source of truth; this table is an index.
CREATE TABLE IF NOT EXISTS escrows (
  pda                 TEXT PRIMARY KEY,
  intent_id           UUID REFERENCES tip_intents(id),
  sender_wallet       TEXT NOT NULL,
  sender_x_handle     TEXT,
  recipient_x_user_id TEXT NOT NULL,
  recipient_x_hash    TEXT NOT NULL,
  lamports            BIGINT NOT NULL,
  nonce               BIGINT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'funded', -- funded | claimed | refunded
  claim_signature     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS escrows_recipient_idx ON escrows(recipient_x_user_id, status);

-- Every mention is recorded exactly once, whatever the outcome.
CREATE TABLE IF NOT EXISTS processed_mentions (
  tweet_id    TEXT PRIMARY KEY,
  outcome     TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable rate limiting, so restarts don't reset a user's budget.
CREATE TABLE IF NOT EXISTS rate_counters (
  bucket      TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count       INT NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Append-only record of anything the attestor key signed.
CREATE TABLE IF NOT EXISTS attestations (
  id          BIGSERIAL PRIMARY KEY,
  escrow_pda  TEXT NOT NULL,
  x_user_id   TEXT NOT NULL,
  wallet      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
