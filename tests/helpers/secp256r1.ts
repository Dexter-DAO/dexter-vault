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

const HALF_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc63255"
) >> BigInt(1); // n / 2 — p256 group order halved

/**
 * Generate a fresh P-256 keypair. Returns the 32-byte private key and the
 * 33-byte SEC1 compressed public key, exactly matching the format Swig +
 * SIMD-0075 expect.
 */
export function generateP256Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true); // compressed = true → 33 bytes
  return { privateKey, publicKey };
}

/**
 * Sign `message` with the given P-256 private key, returning a 64-byte
 * compact (r||s) signature with the s value normalized to lowS form per
 * SIMD-0075's malleability mitigation.
 */
export function signMessage(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const messageHash = sha256(message);
  const sig = p256.sign(messageHash, privateKey, { lowS: true });
  return sig.toCompactRawBytes();
}

/**
 * Build a SIMD-0075 secp256r1 sigverify precompile instruction.
 *
 * Layout (single-signature form):
 *   [num_signatures: u8 = 1]
 *   [padding: u8 = 0]
 *   [Secp256r1SignatureOffsets: 14 bytes]
 *   [signature: 64 bytes]
 *   [pubkey: 33 bytes]
 *   [message: variable]
 *
 * All offset *_instruction_index fields are 0xFFFF meaning "current
 * instruction" — so signature/pubkey/message all live in this same
 * precompile instruction's data buffer.
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
  // Secp256r1SignatureOffsets, all u16 LE
  view.setUint16(DATA_START + 0, signatureOffset, true);
  view.setUint16(DATA_START + 2, 0xffff, true); // signature_instruction_index
  view.setUint16(DATA_START + 4, publicKeyOffset, true);
  view.setUint16(DATA_START + 6, 0xffff, true); // public_key_instruction_index
  view.setUint16(DATA_START + 8, messageOffset, true);
  view.setUint16(DATA_START + 10, messageSize, true);
  view.setUint16(DATA_START + 12, 0xffff, true); // message_instruction_index

  data.set(signature, signatureOffset);
  data.set(publicKey, publicKeyOffset);
  data.set(message, messageOffset);

  return new TransactionInstruction({
    keys: [],
    programId: SECP256R1_PROGRAM_ID,
    data: Buffer.from(data),
  });
}

/** Reproduce the request_withdrawal message the on-chain handler reconstructs. */
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

/** Reproduce the finalize_withdrawal message the on-chain handler reconstructs. */
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

// HALF_ORDER export retained for any future callers; not used directly here.
export { HALF_ORDER };
