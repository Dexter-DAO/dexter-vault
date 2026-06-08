// Phase 1 aggregate-reserve test HELPERS — mainnet.
//
// Companion to credit.ts. These build the MECHANISM-B consent transactions for
// the financier-facing standby-reserve instructions plus the dual-leg
// close_standby:
//   - set_standby_reserve  — financier raises/sets committed_reserve. NO money
//       moves; consent = the vault ix executed as the INNER CPI of the
//       FINANCIER swig's SignV2, with the financier_swig_wallet PDA signing it.
//   - close_standby        — release the standby. EITHER party:
//       * USER leg:      [N-1] secp256r1 precompile, [N] close_standby{User}
//       * FINANCIER leg: close_standby{Financier} as the INNER CPI of the
//                        financier swig's SignV2 (swig_wallet signs).
//
// MECHANISM B — INNER-CPI CONSENT (the highest-judgment piece, replacing the
// old "two-sibling / ProgramExec marker / zero-transfer empty-[]" pattern that
// was the vacuous-consent bug). The rust now REQUIRES the financier's
// swig_wallet PDA to be a SIGNER on set_standby_reserve / close_standby{financier}.
// The ONLY way to produce that signature is to make the vault ix the INNER
// instruction of the financier swig's swig::SignV2 — Swig invoke_signed's the
// swig_wallet PDA over its inner CPIs. So:
//   1. Build the vault ix with `financier_swig_wallet_address` flagged isSigner.
//      (set_standby_reserve: the rust struct types it `Signer`, so Anchor emits
//       isSigner:true automatically. close_standby: the struct types it
//       `AccountInfo` (the user leg shares the struct), so we patch the meta to
//       isSigner:true by hand.)
//   2. Pass that vault ix as the INNER payload to getSignInstructions, routed
//      through a role on the financier swig that holds a `Program(dexter_vault)`
//      permission. Swig's SignV2 gate authorizes the inner CPI under that
//      permission and invoke_signed's the swig_wallet — satisfying the Signer.
//
// PROGRAM-AUTHORITY REGISTRATION: the financier-leg SignV2s authenticate via a
// role carrying a `Program(dexter_vault)` action on the FINANCIER's swig.
// enrollCreditVault only sets the bootstrap draw_credit marker (role 1). Register
// the Program authority post-enrollment with registerProgramAuthorityOnSwig and
// pass the returned role index into the tx builders' `programRole` param. Do NOT
// hardcode a role.
//
// Setup flow the Task 6-9 tests run with these helpers:
//   const fin = await enrollCreditVault(...);                       // role 1 = draw marker
//   const programRole = await registerProgramAuthorityOnSwig({...}); // next free role (returned, not assumed)

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../../target/types/dexter_vault";
import {
  PublicKey,
  SystemProgram,
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
  sendAddAuthorityResilient,
} from "./secp256r1";
import {
  fetchSwig,
  getSignInstructions,
  getAddAuthorityInstructions,
} from "@swig-wallet/kit";
import { Actions, createEd25519AuthorityInfo } from "@swig-wallet/lib";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";

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

// ── (2) close_standby USER-leg op-message ────────────────────────────────────
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

// ── registerProgramAuthorityOnSwig ───────────────────────────────────────────
// Add a NEW role to the financier swig carrying a `Program(dexter_vault)`
// permission, and return its role index. Mirrors credit.ts::registerMarkerOnSwig
// (fetch / role-count / getAddAuthorityInstructions / send), but the new
// authority is an ED25519 authority bound to the provider wallet (NOT a keyless
// ProgramExec marker), and the action is `Actions.set().programLimit({programId})`
// (NOT createProgramExecAuthorityInfo + all()).
//
// AUTHORITY WIRING (highest-judgment piece — why an ed25519 authority on the
// provider wallet, carrying programLimit):
//   - The financier-leg SignV2 is now a REAL signed CPI, not a marker check.
//     getSignInstructions(swig, programRole, [vaultIx], false, {payer}) builds a
//     SignV2 that authenticates via the authority ON programRole. A ProgramExec
//     marker authority has no key — it can't authenticate a real SignV2 that
//     carries an arbitrary inner CPI; it only validates a discriminator marker
//     against a sibling ix (the old, now-removed pattern). So the Program role
//     MUST be a keyed authority that actually signs.
//   - The bootstrap (register-bootstrap.ts) makes role 0 an ED25519 authority
//     bound to `wallet.publicKey` (the provider wallet) with manageAuthority.
//     That same wallet is the tx fee-payer and signs every test tx. So an
//     ED25519 authority bound to `wallet.publicKey` is authenticated for free by
//     the wallet's existing tx signature — no extra Keypair to inject.
//   - We therefore add a SECOND ed25519 authority, also bound to
//     `wallet.publicKey`, whose action is `programLimit({ programId: vault })`.
//     This is exactly the rust `Program` action the SignV2 gate checks for the
//     inner vault CPI. (NOT programAll — too broad; NOT programScope* — those are
//     spend-limited token scopes, wrong primitive.)
//   - role 0 (manageAuthority) signs the ADD, as in registerMarkerOnSwig. The
//     new role index = count of authorities before the add (roles append).
export async function registerProgramAuthorityOnSwig(args: {
  provider: anchor.AnchorProvider;
  swigAddress: PublicKey;
  vaultProgramId: PublicKey;
}): Promise<number> {
  const { provider, swigAddress, vaultProgramId } = args;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const swigForAdd = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForAdd) throw new Error("Swig not visible for program-authority add");

  // The new role index is the count of authorities present before this add.
  const rolesBefore: any[] =
    (swigForAdd as any).roles ?? (swigForAdd as any).authorities ?? [];
  const newRoleIndex = rolesBefore.length;

  // ED25519 authority bound to the provider wallet (same key as bootstrap role 0).
  // Authenticated by the wallet's tx signature — no separate signer needed.
  const programAuthority = createEd25519AuthorityInfo(
    Uint8Array.from(wallet.publicKey.toBytes()),
  );
  // The Program(dexter_vault) action — exactly the rust `Program` gate the SignV2
  // checks for the inner vault CPI.
  const programActions = Actions.set()
    .programLimit({ programId: kitAddress(vaultProgramId.toBase58()) })
    .get();

  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0,
    programAuthority,
    programActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) },
  );
  // Resilient send (same class as registerMarkerOnSwig): a dropped-but-landed
  // addAuthority is confirmed via a role-count poll (must reach
  // newRoleIndex + 1), never blindly re-sent. Happy path unchanged.
  await sendAddAuthorityResilient(
    provider,
    kitInstructionsToWeb3(addAuthorityIxs),
    async () => {
      const s = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
      const roles: any[] = (s as any)?.roles ?? (s as any)?.authorities ?? [];
      return roles.length;
    },
    newRoleIndex + 1,
  );

  return newRoleIndex;
}

// ── Shared inner-CPI SignV2 tail ─────────────────────────────────────────────
// Both financier-leg builders (set_standby_reserve and the close_standby
// financier leg) route their vault ix as the INNER CPI of the financier swig's
// SignV2. This helper single-sources that shared tail: fetch the financier swig,
// build the SignV2 with the vault ix as the inner payload through the Program
// role, and send under a 600k-CU cap.
//
// MECHANISM B: the vault ix is passed as the INNER instruction list — `[vaultIx]`,
// NOT preInstructions, NOT empty `[]`. Swig's SignV2 authorizes that inner CPI
// under the role's Program(dexter_vault) permission and invoke_signed's the
// swig_wallet PDA over it, producing the swig_wallet signature the rust now
// requires. The caller is responsible for flagging financier_swig_wallet_address
// isSigner on the vault ix (automatic for set_standby_reserve via the rust Signer
// type; a manual meta patch for close_standby).
async function sendVaultCpiSignV2(
  provider: anchor.AnchorProvider,
  financierSwig: PublicKey,
  programRole: number,
  vaultIx: TransactionInstruction,
): Promise<void> {
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(financierSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("Financier swig not visible for sign");

  const signKitIxs = await getSignInstructions(
    swigForSign,
    programRole,
    [vaultIx as any], // ← inner CPI = the vault ix (NOT preInstructions, NOT empty [])
    false,
    { payer: kitAddress(wallet.publicKey.toBase58()) },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  // The CU-limit + the SignV2 ixs. signWeb3Ixs do NOT embed the blockhash (the
  // Transaction does), so rebuilding a fresh Transaction over the SAME ixs with
  // a fresh blockhash is the correct way to re-send a dropped tx.
  const innerIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  ];

  const buildTx = async (): Promise<Transaction> => {
    const { blockhash } = await provider.connection.getLatestBlockhash("finalized");
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = provider.wallet.publicKey;
    tx.add(...innerIxs);
    return tx;
  };

  const isTransientDrop = (err: any): boolean => {
    const msg = String(err?.message ?? err);
    return (
      msg.includes("TransactionExpiredTimeoutError") ||
      msg.includes("was not confirmed") ||
      msg.includes("block height exceeded") ||
      msg.includes("Blockhash not found") ||
      msg.includes("expired")
    );
  };

  // A revert on the RE-SEND that means the FIRST send actually landed (the
  // standby was already set/closed by the dropped-but-confirmed tx). These are
  // the program/state errors a no-op re-close/re-set produces; seeing one on
  // retry is PROOF the original send took effect → treat as success.
  const isAlreadyAppliedRevert = (err: any): boolean => {
    const msg = String(err?.message ?? err);
    return (
      msg.includes("StandbyBackerMismatch") ||
      msg.includes("StandbyNotFound") ||
      msg.includes("StandbyAlreadyClosed") ||
      msg.includes("AccountNotInitialized") ||
      msg.includes("0xbc4") || // AccountNotInitialized (standby_backer/vault gone)
      msg.includes("ReserveBelowPromised") || // re-set racing the landed set
      msg.includes("AccountOwnedByWrongProgram") // closed account reassigned
    );
  };

  // (1) Single-shot send — identical to the original happy path.
  try {
    await provider.sendAndConfirm(await buildTx());
    return;
  } catch (err: any) {
    // Program revert on the FIRST send → genuine failure, rethrow (a real
    // StandbyStillBorrowed / FinancierConsentMissing must still surface).
    if (!isTransientDrop(err)) throw err;
  }

  // (2) Transient drop: the SignV2 MAY have landed. Re-send with a fresh
  //     blockhash. If THIS one reverts with an "already-applied" state error,
  //     the first send landed → success. Any other revert is a real failure.
  try {
    await provider.sendAndConfirm(await buildTx());
  } catch (err: any) {
    if (isAlreadyAppliedRevert(err)) return; // first send had landed.
    throw err;
  }
}

// ── (3) set_standby_reserve via inner-CPI SignV2 ─────────────────────────────
// The vault ix is the INNER CPI of the financier swig's SignV2 (Program role).
// The rust struct types financier_swig_wallet_address as `Signer`, so Anchor's
// .instruction() emits isSigner:true for it automatically — NO manual patch. The
// rust also REMOVED instructions_sysvar from this instruction's accounts, so it
// is NOT in accountsPartial. programRole is the role returned by
// registerProgramAuthorityOnSwig (do NOT hardcode).
export async function buildSetStandbyReserveTx(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    financierSwig: PublicKey;
    financierSwigWalletAddress: PublicKey;
    newReserve: bigint;
    programRole: number;
  },
): Promise<void> {
  const { financierSwig, financierSwigWalletAddress, newReserve, programRole } =
    args;

  const [standbyBacker] = deriveStandbyBackerPda(financierSwig);

  // Accounts: financier_swig, financier_swig_wallet_address (Signer — Anchor
  // auto-emits isSigner:true), standby_backer, fee_payer, system_program.
  // NO instructions_sysvar (the rust removed it from set_standby_reserve).
  const setStandbyReserveVaultIx = await program.methods
    .setStandbyReserve({ newReserve: new anchor.BN(newReserve.toString()) })
    .accountsPartial({
      financierSwig,
      financierSwigWalletAddress,
      standbyBacker,
      feePayer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Mechanism B: vault ix as the inner CPI of the financier swig's SignV2.
  await sendVaultCpiSignV2(
    provider,
    financierSwig,
    programRole,
    setStandbyReserveVaultIx,
  );
}

// ── (4) close_standby — both consent legs ────────────────────────────────────
// closer:"user"     → [N-1] secp256r1 precompile, [N] close_standby{user}
// closer:"financier"→ close_standby{financier} as the INNER CPI of the financier
//                     swig's SignV2 (Program role; swig_wallet signs).
//
// Anchor encodes the Closer enum as { user: {} } / { financier: {} }. The
// financier leg passes empty buffers for clientDataJson/authenticatorData (the
// rust handler ignores them). programRole is required for the financier leg only.
//
// close_standby KEEPS instructions_sysvar (the user leg's passkey verifier reads
// it), and the rust struct types financier_swig_wallet_address as `AccountInfo`
// (the user leg shares the struct), so for the financier leg we MUST manually
// patch that account's meta to isSigner:true before routing it through SignV2.
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
    programRole?: number;
  },
): Promise<void> {
  const {
    closer,
    vaultPda,
    financierSwig,
    financierSwigWalletAddress,
    userPasskey,
    programRole,
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
  if (programRole === undefined)
    throw new Error("close_standby financier leg requires programRole");

  // KEEPS instructions_sysvar (the struct still has it — the user leg needs it).
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

  // The struct types financier_swig_wallet_address as AccountInfo (user leg
  // shares it), so Anchor emits isSigner:false. Mechanism B needs the swig_wallet
  // to sign the inner CPI, so patch the meta to isSigner:true — compactInstructions
  // then carries that flag to the outer flattened accounts and Swig invoke_signed's
  // the PDA at runtime.
  const walletMeta = closeVaultIx.keys.find((k) =>
    k.pubkey.equals(financierSwigWalletAddress),
  );
  if (!walletMeta)
    throw new Error("financier_swig_wallet_address not in close ix keys");
  walletMeta.isSigner = true;

  // Mechanism B: vault ix as the inner CPI of the financier swig's SignV2.
  await sendVaultCpiSignV2(provider, financierSwig, programRole, closeVaultIx);
}
