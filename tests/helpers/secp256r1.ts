import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Transaction,
  type Signer,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider } from "@coral-xyz/anchor";

export const SECP256R1_PROGRAM_ID = new PublicKey(
  "Secp256r1SigVerify1111111111111111111111111"
);

const SIGNATURE_SERIALIZED_SIZE = 64;
const COMPRESSED_PUBKEY_SERIALIZED_SIZE = 33;
const SIGNATURE_OFFSETS_SERIALIZED_SIZE = 14;
const DATA_START = 2;

const RP_ID = "dexter.cash";

export interface P256Keypair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function generateP256Keypair(): P256Keypair {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

function base64urlEncode(input: Uint8Array): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a realistic clientDataJSON. In a real browser this is produced by
 * the user agent during navigator.credentials.get(); here we synthesize one
 * with the correct shape so the on-chain parser can recover the challenge.
 */
function buildClientDataJSON(challengeBytes: Uint8Array, origin = `https://${RP_ID}`): Uint8Array {
  const challenge = base64urlEncode(challengeBytes);
  const obj = {
    type: "webauthn.get",
    challenge,
    origin,
    crossOrigin: false,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * Build a minimal valid authenticatorData per WebAuthn spec:
 *   - 32 bytes: rpIdHash = sha256("dexter.cash")
 *   - 1 byte:   flags (UP=0x01 | UV=0x04 → 0x05)
 *   - 4 bytes:  signCount (big-endian u32)
 */
function buildAuthenticatorData(signCount = 1): Uint8Array {
  const rpIdHash = sha256(new TextEncoder().encode(RP_ID));
  const out = new Uint8Array(32 + 1 + 4);
  out.set(rpIdHash, 0);
  out[32] = 0x05;
  const view = new DataView(out.buffer);
  view.setUint32(33, signCount, false);
  return out;
}

/**
 * Simulate a full WebAuthn ceremony for a given operation message.
 *
 * Returns:
 *   - clientDataJSON / authenticatorData — pass to the vault instruction
 *   - precompileMessage — what SIMD-0075 verifies (authData || sha256(clientDataJSON))
 *   - signature — 64-byte compact (r||s) lowS over precompileMessage
 */
export interface SignedWebAuthnPayload {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  precompileMessage: Uint8Array;
  signature: Uint8Array;
}

export function signOperationWithPasskey(
  keypair: P256Keypair,
  operationMessage: Uint8Array,
  signCount = 1
): SignedWebAuthnPayload {
  const challengeHash = sha256(operationMessage);
  const clientDataJSON = buildClientDataJSON(challengeHash);
  const authenticatorData = buildAuthenticatorData(signCount);

  const clientDataHash = sha256(clientDataJSON);
  const precompileMessage = new Uint8Array(authenticatorData.length + 32);
  precompileMessage.set(authenticatorData, 0);
  precompileMessage.set(clientDataHash, authenticatorData.length);

  const messageHash = sha256(precompileMessage);
  const sig = p256.sign(messageHash, keypair.privateKey, { lowS: true });
  const signature = sig.toCompactRawBytes();

  return { clientDataJSON, authenticatorData, precompileMessage, signature };
}

/**
 * Build a SIMD-0075 secp256r1 sigverify precompile instruction.
 */
export function buildSecp256r1VerifyInstruction(
  publicKey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array
): TransactionInstruction {
  if (publicKey.length !== COMPRESSED_PUBKEY_SERIALIZED_SIZE) {
    throw new Error(`expected ${COMPRESSED_PUBKEY_SERIALIZED_SIZE}-byte compressed pubkey`);
  }
  if (signature.length !== SIGNATURE_SERIALIZED_SIZE) {
    throw new Error(`expected ${SIGNATURE_SERIALIZED_SIZE}-byte signature`);
  }

  const signatureOffset = DATA_START + SIGNATURE_OFFSETS_SERIALIZED_SIZE;
  const publicKeyOffset = signatureOffset + SIGNATURE_SERIALIZED_SIZE;
  const messageOffset = publicKeyOffset + COMPRESSED_PUBKEY_SERIALIZED_SIZE;
  const messageSize = message.length;

  const totalLen = messageOffset + messageSize;
  const data = new Uint8Array(totalLen);

  data[0] = 1;
  data[1] = 0;

  const view = new DataView(data.buffer);
  view.setUint16(DATA_START + 0, signatureOffset, true);
  view.setUint16(DATA_START + 2, 0xffff, true);
  view.setUint16(DATA_START + 4, publicKeyOffset, true);
  view.setUint16(DATA_START + 6, 0xffff, true);
  view.setUint16(DATA_START + 8, messageOffset, true);
  view.setUint16(DATA_START + 10, messageSize, true);
  view.setUint16(DATA_START + 12, 0xffff, true);

  data.set(signature, signatureOffset);
  data.set(publicKey, publicKeyOffset);
  data.set(message, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: SECP256R1_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

// ── Operation message builders (must match Rust handlers byte-for-byte) ──

export function setSwigMessage(swigAddress: PublicKey): Uint8Array {
  const tag = new TextEncoder().encode("set_swig");
  const buf = new Uint8Array(tag.length + 32);
  buf.set(tag, 0);
  buf.set(swigAddress.toBytes(), tag.length);
  return buf;
}

export function requestWithdrawalMessage(
  amount: bigint,
  destination: PublicKey,
  signedAt: bigint
): Uint8Array {
  const tag = new TextEncoder().encode("request_withdrawal");
  const buf = new Uint8Array(tag.length + 8 + 32 + 8);
  buf.set(tag, 0);
  new DataView(buf.buffer).setBigUint64(tag.length, amount, true);
  buf.set(destination.toBytes(), tag.length + 8);
  new DataView(buf.buffer).setBigInt64(tag.length + 8 + 32, signedAt, true);
  return buf;
}

export function finalizeWithdrawalMessage(
  amount: bigint,
  destination: PublicKey
): Uint8Array {
  const tag = new TextEncoder().encode("finalize_withdrawal");
  const buf = new Uint8Array(tag.length + 8 + 32);
  buf.set(tag, 0);
  new DataView(buf.buffer).setBigUint64(tag.length, amount, true);
  buf.set(destination.toBytes(), tag.length + 8);
  return buf;
}

export function forceReleaseMessage(swigAddress: PublicKey): Uint8Array {
  const tag = new TextEncoder().encode("force_release");
  const buf = new Uint8Array(tag.length + 32);
  buf.set(tag, 0);
  buf.set(swigAddress.toBytes(), tag.length);
  return buf;
}

export function rotatePasskeyMessage(newPasskeyPubkey: Uint8Array): Uint8Array {
  const tag = new TextEncoder().encode("rotate_passkey");
  const buf = new Uint8Array(tag.length + 33);
  buf.set(tag, 0);
  buf.set(newPasskeyPubkey, tag.length);
  return buf;
}

export function provePasskeyMessage(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 32) throw new Error("challenge must be 32 bytes");
  const tag = new TextEncoder().encode("siwx_login");
  const buf = new Uint8Array(tag.length + 32);
  buf.set(tag, 0);
  buf.set(challenge, tag.length);
  return buf;
}

// ── Session-key (v2) message builders ────────────────────────────────
//
// MUST match build_registration_message / build_revocation_message in the
// Rust handlers byte-for-byte. If either side drifts, the precompile
// verifies a different message than the program reconstructs and every
// signature looks forged.

/** Domain separator, 32 bytes, padded with NULs. */
const REGISTER_DOMAIN = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REGISTER_V1"), 0);
  return buf;
})();

const REVOKE_DOMAIN = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REVOKE_V1"), 0);
  return buf;
})();

export interface SessionRegisterMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes
  maxAmount: bigint;
  expiresAt: bigint;                 // i64 seconds
  allowedCounterparty: PublicKey;
  nonce: number;                     // u32
}

/** 180-byte session-registration message. See register_session_key.rs. */
export function sessionRegisterMessage(args: SessionRegisterMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) throw new Error("sessionPubkey must be 32 bytes");
  const buf = new Uint8Array(180);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  if (o !== 180) throw new Error(`session register message wrong length: ${o}`);
  return buf;
}

export interface SessionRevokeMessageArgs {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;        // 32 bytes; must match the active session
}

/** 128-byte session-revocation message; binds to the specific session pubkey. */
export function sessionRevokeMessage(args: SessionRevokeMessageArgs): Uint8Array {
  if (args.sessionPubkey.length !== 32) throw new Error("sessionPubkey must be 32 bytes");
  const buf = new Uint8Array(128);
  let o = 0;
  buf.set(REVOKE_DOMAIN, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  if (o !== 128) throw new Error(`session revoke message wrong length: ${o}`);
  return buf;
}

// ── Funding helper for mainnet-safe tests ───────────────────────────
//
// `provider.connection.requestAirdrop` returns 410 on mainnet (the API is
// localnet-only). Tests that mint a fresh authority keypair and need it to
// sign transactions must instead receive lamports via a SystemProgram
// transfer from the provider's already-funded wallet. The amount only needs
// to cover transaction fees (≪0.001 SOL); use 0.005 SOL for headroom.
//
// Use from a `before` or `beforeEach` hook: `await fundFromProvider(provider, authority.publicKey)`.
export async function fundFromProvider(
  provider: AnchorProvider,
  recipient: PublicKey,
  lamports: number = 5_000_000, // 0.005 SOL
): Promise<void> {
  const ix = SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: recipient,
    lamports,
  });
  const tx = new Transaction().add(ix);
  await provider.sendAndConfirm(tx);
}

// ── Mainnet read-after-write propagation guard ──────────────────────
//
// On mainnet, a tx that confirmed at `confirmed` commitment may not yet be
// visible to the leader's bank when the very next tx in the same suite tries
// to read the freshly-created account. The on-chain Anchor handler then
// fails with AccountNotInitialized (error 3012 / 0xbc4) even though the
// account was created moments ago.
//
// Call this after `initialize_vault` (or any account-creating tx) before the
// next tx that depends on that account existing. It polls getAccountInfo
// against the same connection until the account materializes.
export async function pollUntilAccountExists(
  connection: Connection,
  pubkey: PublicKey,
  timeoutMs: number = 15_000,
  intervalMs: number = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await connection.getAccountInfo(pubkey, "finalized");
    if (info) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollUntilAccountExists: ${pubkey.toBase58()} did not appear within ${timeoutMs}ms`,
  );
}

// Poll a typed Anchor account.fetch() until a predicate is satisfied.
// Read replicas on Helius can briefly serve stale state even after a
// `finalized` write confirmation. Use this when a test asserts a state
// transition immediately after the tx that caused it.
export async function pollUntilAccount<T>(
  fetchFn: () => Promise<T>,
  predicate: (acct: T) => boolean,
  timeoutMs: number = 15_000,
  intervalMs: number = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await fetchFn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `pollUntilAccount: predicate not satisfied within ${timeoutMs}ms (last=${JSON.stringify(last)})`,
  );
}

// ── Test provider factory ───────────────────────────────────────────
//
// Tests run against MAINNET (the secp256r1 precompile is mainnet-only).
// Anchor's default commitment is "processed", which is pre-confirmation
// and races against propagation between RPC nodes — multi-tx tests then
// see stale state and fail nondeterministically.
//
// We deliberately use `finalized` for the test suite. ~13s per tx is slow
// but the tests run rarely and DETERMINISTIC GREEN beats fast-and-flaky.
// Production (FE, API, MCP) still uses `confirmed`; test commitment ≠
// product commitment is intentional — the suite tests program correctness,
// not UX latency.
//
// Reads env: ANCHOR_PROVIDER_URL, ANCHOR_WALLET (same as anchor test).
export function makeTestProvider(): AnchorProvider {
  const url = process.env.ANCHOR_PROVIDER_URL;
  if (!url) throw new Error("ANCHOR_PROVIDER_URL is not set");
  const connection = new Connection(url, "finalized");
  // anchor.Wallet.local() reads ANCHOR_WALLET
  const wallet = (anchor as any).Wallet.local();
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "finalized",
    preflightCommitment: "finalized",
    skipPreflight: false,
  });
  anchor.setProvider(provider);
  return provider;
}
