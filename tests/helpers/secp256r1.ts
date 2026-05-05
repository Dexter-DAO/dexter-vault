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
) >> BigInt(1);

export function generateP256Keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, true);
  return { privateKey, publicKey };
}

export function signMessage(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  const messageHash = sha256(message);
  const sig = p256.sign(messageHash, privateKey, { lowS: true });
  return sig.toCompactRawBytes();
}

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

export function setSwigMessage(swigAddress: PublicKey): Uint8Array {
  const tag = new TextEncoder().encode("set_swig");
  const buf = new Uint8Array(tag.length + 32);
  buf.set(tag, 0);
  buf.set(swigAddress.toBytes(), tag.length);
  return buf;
}

export { HALF_ORDER };
