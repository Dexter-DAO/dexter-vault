import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

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
