// Phase 1 aggregate-reserve test HELPERS — mainnet.
//
// Companion to credit.ts. These build the two-sibling consent transactions for
// the financier-facing standby-reserve instructions plus the dual-leg
// close_standby:
//   - set_standby_reserve  — financier raises/sets committed_reserve. NO money
//       moves; consent = paired [N+1] swig::SignV2 (zero-transfer) whose
//       ProgramExec marker is the set_standby_reserve discriminator on the
//       FINANCIER's swig.
//   - close_standby        — release the standby. EITHER party:
//       * USER leg:      [N-1] secp256r1 precompile, [N] close_standby{User}
//       * FINANCIER leg: [N] close_standby{Financier}, [N+1] swig::SignV2(zero)
//
// THE ZERO-TRANSFER PATTERN (highest-judgment piece): set_standby_reserve and
// the close_standby financier leg move NO money. The SignV2 is consent-only —
// its ProgramExec authority authenticates against the PRECEDING vault ix
// (program_id + discriminator marker + accounts[0]=swig / [1]=swig_wallet),
// IGNORING the inner instruction payload. So we pass an EMPTY array `[]` as the
// SignV2's instruction list. The Swig SDK serializes an empty Vec<Instruction>
// to a 1-byte [0x00] payload, which Swig ACCEPTS (a literally-0-length payload
// would be rejected as MissingInstructions, but the SDK never emits that from
// `[]`). The empty payload does NOT weaken the consent proof.
//
// MARKER REGISTRATION: both financier-leg SignV2s authenticate via a ProgramExec
// marker on the FINANCIER's swig. enrollCreditVault only sets the bootstrap
// marker (role 1, default DRAW_CREDIT_DISCRIMINATOR). The set_standby_reserve
// and close_standby markers are ADDITIONAL — register them post-enrollment with
// registerMarkerOnSwig (re-exported below for one-import ergonomics) and pass
// the returned role index into the tx builders' `markerRole` param. Do NOT
// hardcode a role.
//
// Setup flow the Task 6-9 tests run with these helpers:
//   const fin = await enrollCreditVault(...);                 // role 1 = draw marker
//   const setRole   = await registerMarkerOnSwig({ ..., discriminator: SET_STANDBY_RESERVE_DISCRIMINATOR }); // role 2
//   const closeRole = await registerMarkerOnSwig({ ..., discriminator: CLOSE_STANDBY_DISCRIMINATOR });       // role 3

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { kitInstructionsToWeb3 } from "./register-bootstrap";
import {
  P256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
} from "./secp256r1";
import { fetchSwig, getSignInstructions } from "@swig-wallet/kit";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import { createHash } from "crypto";

// Re-export registerMarkerOnSwig so the standby tests need only ONE import to
// place the set_standby_reserve / close_standby markers on the financier swig.
export { registerMarkerOnSwig } from "./credit";

// ── Anchor discriminators ────────────────────────────────────────────────────
// Derived at MODULE LOAD via sha256("global:<name>")[..8] so they're provably
// correct (self-verifying). Cross-checked against target/idl/dexter_vault.json:
//   set_standby_reserve -> [198, 227, 172, 10, 133, 119, 213, 7]
//   close_standby       -> [218,  35,  75, 51,  72, 244,  20, 108]
// Both methods produce identical bytes (verified before commit).
export const SET_STANDBY_RESERVE_DISCRIMINATOR: Uint8Array = Uint8Array.from(
  createHash("sha256").update("global:set_standby_reserve").digest().subarray(0, 8),
);
export const CLOSE_STANDBY_DISCRIMINATOR: Uint8Array = Uint8Array.from(
  createHash("sha256").update("global:close_standby").digest().subarray(0, 8),
);

// ── (1) StandbyBacker PDA ────────────────────────────────────────────────────
// The program's declared id (the IDL "address" field; equals program.programId).
const DEXTER_VAULT_PROGRAM_ID = new PublicKey(
  "Hg3wRaydFtJhYrdvYrKECacpJYDsC9Px7yKmpncj2fhc",
);

// STANDBY_BACKER_SEED = b"standby-backer" (state.rs:223). PDA = [seed, financier_swig].
export function deriveStandbyBackerPda(
  financierSwig: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("standby-backer"), financierSwig.toBuffer()],
    DEXTER_VAULT_PROGRAM_ID,
  );
}

// ── (5) close_standby USER-leg op-message ────────────────────────────────────
// MUST match close_standby.rs handler byte-for-byte:
//   "close_standby" (13) || vaultPda (32) || financierSwig (32) = 77 bytes.
export function buildCloseStandbyMessage(
  vaultPda: PublicKey,
  financierSwig: PublicKey,
): Uint8Array {
  const tag = new TextEncoder().encode("close_standby"); // 13 bytes
  const buf = new Uint8Array(tag.length + 32 + 32);
  let o = 0;
  buf.set(tag, o);
  o += tag.length;
  buf.set(vaultPda.toBytes(), o);
  o += 32;
  buf.set(financierSwig.toBytes(), o);
  o += 32;
  if (o !== 77) throw new Error(`close_standby message wrong length: ${o}`);
  return buf;
}

// ── (3) set_standby_reserve two-sibling tx ───────────────────────────────────
// [N]   vault::set_standby_reserve(newReserve)  — financier_swig@0, wallet@1
// [N+1] swig::SignV2(<zero-transfer>)           — ProgramExec marker on financier swig
//
// The vault ix goes in preInstructions so getSignInstructions returns BOTH it
// and the SignV2 in one ordered array. The instruction list is EMPTY (`[]`) —
// zero-transfer consent. markerRole is the role returned by registerMarkerOnSwig
// for SET_STANDBY_RESERVE_DISCRIMINATOR (do NOT hardcode).
export async function buildSetStandbyReserveTx(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    financierSwig: PublicKey;
    financierSwigWalletAddress: PublicKey;
    newReserve: bigint;
    markerRole: number;
  },
): Promise<void> {
  const { financierSwig, financierSwigWalletAddress, newReserve, markerRole } =
    args;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const [standbyBacker] = deriveStandbyBackerPda(financierSwig);

  const setStandbyReserveVaultIx = await program.methods
    .setStandbyReserve({ newReserve: new anchor.BN(newReserve.toString()) })
    .accountsPartial({
      financierSwig,
      financierSwigWalletAddress,
      standbyBacker,
      feePayer: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(financierSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("Financier swig not visible for sign");

  // Zero-transfer: EMPTY instruction list `[]` → SDK serializes to [0x00], which
  // Swig accepts. The ProgramExec authority authenticates against the preceding
  // vault ix, ignoring the (empty) inner payload.
  const signKitIxs = await getSignInstructions(
    swigForSign,
    markerRole,
    [],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [setStandbyReserveVaultIx as any],
    },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  );
  await provider.sendAndConfirm(tx);
}

// ── (4) close_standby — both consent legs ────────────────────────────────────
// closer:"user"     → [N-1] secp256r1 precompile, [N] close_standby{user}
// closer:"financier"→ [N] close_standby{financier}, [N+1] swig::SignV2(zero)
//
// Anchor encodes the Closer enum as { user: {} } / { financier: {} }. The
// financier leg passes empty buffers for clientDataJson/authenticatorData (the
// rust handler ignores them). markerRole is required for the financier leg only.
export async function buildCloseStandbyTx(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    closer: "user" | "financier";
    vaultPda: PublicKey;
    financierSwig: PublicKey;
    financierSwigWalletAddress: PublicKey;
    // user leg:
    userPasskey?: P256Keypair;
    // financier leg:
    markerRole?: number;
  },
): Promise<void> {
  const {
    closer,
    vaultPda,
    financierSwig,
    financierSwigWalletAddress,
    userPasskey,
    markerRole,
  } = args;

  const [standbyBacker] = deriveStandbyBackerPda(financierSwig);

  if (closer === "user") {
    if (!userPasskey)
      throw new Error("close_standby user leg requires userPasskey");

    // [N-1] secp256r1 precompile over "close_standby"||vault||financier, then
    // [N] close_standby{User}. The precompile MUST immediately precede the vault
    // ix (the handler reads instructions_sysvar at current_index - 1).
    const opMsg = buildCloseStandbyMessage(vaultPda, financierSwig);
    const signed = signOperationWithPasskey(userPasskey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      userPasskey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    const closeIx = await program.methods
      .closeStandby({
        closer: { user: {} },
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        financierSwig,
        financierSwigWalletAddress,
        vault: vaultPda,
        standbyBacker,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await provider.sendAndConfirm(
      new Transaction().add(precompileIx, closeIx),
    );
    return;
  }

  // ── financier leg ──────────────────────────────────────────────────────────
  if (markerRole === undefined)
    throw new Error("close_standby financier leg requires markerRole");

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const closeVaultIx = await program.methods
    .closeStandby({
      closer: { financier: {} },
      clientDataJson: Buffer.from([]), // ignored on the financier leg
      authenticatorData: Buffer.from([]), // ignored on the financier leg
    })
    .accountsPartial({
      financierSwig,
      financierSwigWalletAddress,
      vault: vaultPda,
      standbyBacker,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(financierSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("Financier swig not visible for sign");

  // Same zero-transfer SignV2 pattern as set_standby_reserve: EMPTY `[]`.
  const signKitIxs = await getSignInstructions(
    swigForSign,
    markerRole,
    [],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [closeVaultIx as any],
    },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  );
  await provider.sendAndConfirm(tx);
}
