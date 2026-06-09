// Session-PDA test harness for the V6 multi-session overcommit gate.
//
// register_session_key.rs derives the per-counterparty session PDA at
//   [SESSION_SEED, vault.key(), allowed_counterparty]
// and the on-chain overcommit gate (handler step C) requires the caller to pass
// EVERY OTHER sibling SessionAccount in `remaining_accounts`, in STRICT-ASCENDING
// pubkey order (`>` not `>=`, so dedup + canonical order in one check), with the
// live siblings read-only and the EXPIRED siblings WRITABLE (the gate sweeps them
// — zeroes version + SessionRegistration — which requires writability).
//
// This module centralizes:
//   - deriveSessionPda            — match the on-chain seeds
//   - sortSessionAccounts         — strict-ascending raw-byte sort (== Rust Pubkey Ord)
//   - siblingRemainingAccounts    — build the AccountMeta[] with sweep writability

import { PublicKey } from "@solana/web3.js";

const SESSION_SEED = Buffer.from("session");

/** Derive the per-counterparty session PDA + bump (matches the on-chain
 *  seeds [SESSION_SEED, vault, allowed_counterparty]). */
export function deriveSessionPda(
  programId: PublicKey,
  vault: PublicKey,
  counterparty: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_SEED, vault.toBuffer(), counterparty.toBuffer()],
    programId,
  );
}

/** Sort SessionAccount pubkeys STRICT ASCENDING by raw 32-byte value — this is
 *  EXACTLY what the on-chain gate requires (Rust Pubkey: Ord over [u8;32], which
 *  is lexicographic big-endian byte comparison). web3.js PublicKey has no Ord, so
 *  we compare the raw buffers via Buffer.compare. */
export function sortSessionAccounts(keys: PublicKey[]): PublicKey[] {
  return [...keys].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
}

/** Build the remaining_accounts AccountMeta[] for the register gate: sibling
 *  SessionAccount PDAs, STRICT ASCENDING, the live ones read-only and (if
 *  includeExpired) expired ones WRITABLE (the on-chain sweep clears them, which
 *  requires writability). Callers that pass expired siblings for the sweep must
 *  mark them isWritable=true.
 *  @param siblings array of {pubkey, isExpired} — isExpired siblings get isWritable=true */
export function siblingRemainingAccounts(
  siblings: { pubkey: PublicKey; isExpired?: boolean }[],
): { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] {
  // sort by pubkey ascending (the gate requires strict ascending regardless of live/expired)
  const sorted = [...siblings].sort((a, b) =>
    Buffer.compare(a.pubkey.toBuffer(), b.pubkey.toBuffer()),
  );
  return sorted.map((s) => ({
    pubkey: s.pubkey,
    isSigner: false,
    isWritable: s.isExpired === true, // expired siblings must be writable (swept/cleared on-chain)
  }));
}
