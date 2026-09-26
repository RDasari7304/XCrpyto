// Generates the local secrets you need for .env. Devnet/localnet only.
import { Keypair } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';

const attestor = Keypair.generate();
console.log(`SESSION_PEPPER=${randomBytes(32).toString('base64url')}`);
console.log(`ATTESTOR_SECRET_KEY=${bs58.encode(attestor.secretKey)}`);
console.log(`\n# attestor pubkey (not a secret): ${attestor.publicKey.toBase58()}`);
