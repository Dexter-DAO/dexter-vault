// Shared credit (Credit-L2) test harness — mainnet.
//
// Credit-L2 instructions (open_standby / draw_credit / repay_credit /
// seize_collateral) all gate `vault.version == VAULT_VERSION_V5`. The
// bootstrap helper (`bootstrapForRegister`) creates V4 vaults, so EVERY
// credit test must:
//   1. enroll a V4 vault (bootstrapForRegister)
//   2. migrate it to V5 (migrate_v4_to_v5)
//   3. THEN open_standby / draw_credit / etc.
//
// This module centralizes:
//   - buildOpenStandbyMessage — the open_standby passkey op-message
//   - migrateVaultToV5 — drive migrate_v4_to_v5 + poll until version == 5
//   - enrollCreditVault — bootstrap + migrate convenience (FINANCIER vault)
//   - openStandby — atomic [secp256r1 precompile, open_standby]
//   - drawCreditAtomic — atomic [draw_credit, swig::SignV2(TransferChecked)]
//
// The draw_credit SignV2 spends the FINANCIER's swig_wallet ATA, so the
// draw_credit ProgramExec marker MUST live on the FINANCIER's swig. We set
// it as the bootstrap `programExecMarker` (role 1) at swig-create time — the
// simplest correct path. That means drawCreditAtomic routes getSignInstructions
// through ROLE 1 (NOT role 2 like the settle test, which ADDED a second marker
// post-enrollment).

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
import {
  bootstrapForRegister,
  kitInstructionsToWeb3,
  RegisterReadyVault,
} from "./register-bootstrap";
import {
  P256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  pollUntilAccount,
  sendAddAuthorityResilient,
  sendAndConfirmWithRetry,
  sendPrecompilePairResilient,
  makeRateLimitedKitRpc,
} from "./secp256r1";
import {
  fetchSwig,
  getSignInstructions,
  getAddAuthorityInstructions,
} from "@swig-wallet/kit";
import {
  Actions,
  createProgramExecAuthorityInfo,
} from "@swig-wallet/lib";
import { address as kitAddress } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { getAccount } from "@solana/spl-token";

// draw_credit's Anchor discriminator — sha256("global:draw_credit")[..8].
// This is the ProgramExec marker that lets the [N+1] swig::SignV2 in the
// draw atomic flow validate against the FINANCIER swig's on-chain marker list.
export const DRAW_CREDIT_DISCRIMINATOR = new Uint8Array([
  20, 84, 47, 211, 78, 117, 195, 210,
]);

// repay_credit's Anchor discriminator — sha256("global:repay_credit")[..8].
// The SignV2 in the repay atomic flow spends the USER's swig_wallet ATA, so
// THIS marker must be registered on the USER's swig (post-enrollment).
export const REPAY_CREDIT_DISCRIMINATOR = new Uint8Array([
  38, 113, 240, 182, 109, 179, 154, 245,
]);

// seize_collateral's Anchor discriminator — sha256("global:seize_collateral")[..8].
// The SignV2 in the seize atomic flow spends the USER's swig_wallet ATA, so
// THIS marker must be registered on the USER's swig (post-enrollment).
export const SEIZE_COLLATERAL_DISCRIMINATOR = new Uint8Array([
  40, 250, 7, 243, 168, 184, 116, 154,
]);

// The role index the draw_credit marker ends up on when set as the bootstrap
// programExecMarker. bootstrapForRegister creates role 0 (manageAuthority)
// then adds role 1 (ProgramExec, the bootstrap marker). So the draw_credit
// marker is role 1.
export const DRAW_CREDIT_MARKER_ROLE = 1;

/**
 * (a) open_standby op-message — MUST match open_standby.rs::op_msg byte-for-byte:
 *   "open_standby" (12) || vaultPda (32) || financierSwig (32) || cap u64 LE (8)
 * Total 84 bytes.
 */
export function buildOpenStandbyMessage(
  vaultPda: PublicKey,
  financierSwig: PublicKey,
  cap: bigint,
): Uint8Array {
  const tag = new TextEncoder().encode("open_standby"); // 12 bytes
  const buf = new Uint8Array(tag.length + 32 + 32 + 8);
  let o = 0;
  buf.set(tag, o);
  o += tag.length;
  buf.set(vaultPda.toBytes(), o);
  o += 32;
  buf.set(financierSwig.toBytes(), o);
  o += 32;
  new DataView(buf.buffer).setBigUint64(o, cap, true);
  o += 8;
  if (o !== 84) throw new Error(`open_standby message wrong length: ${o}`);
  return buf;
}

/**
 * (b) Migrate a V4 vault to V5 via migrate_v4_to_v5, then poll until the
 * on-chain `version` field reads 5.
 *
 * VERSION-AWARE: initialize_vault now stamps fresh vaults V6 directly, so a
 * just-bootstrapped vault has NOTHING for this hop to do — migrate_v4_to_v5
 * requires version == 4 and would revert UnsupportedVaultVersion. If the vault
 * already reads >= 5 this is a no-op (the hop is already satisfied; credit
 * instructions gate on V5 || V6, so a V6 vault needs no V5 stop). Callers that
 * truly hold a V4 vault (pre-fix mainnet accounts) still walk the migration.
 */
export async function migrateVaultToV5(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
): Promise<void> {
  // Raw version byte (data[8], after the 8-byte discriminator) — NOT the IDL
  // decoder, which can't parse pre-V6 layouts (Option<SessionRegistration> in
  // the middle of the struct).
  const info = await provider.connection.getAccountInfo(vaultPda);
  if (info && info.data.length > 8 && info.data[8] >= 5) return; // hop already satisfied
  // migrate is safe to resend on a CONFIRMED transient drop: the resend either
  // lands (it truly dropped) or reverts because the vault is already V5 — and the
  // trailing pollUntilAccount(version==5) is the source of truth either way. Build
  // the ix and route through sendAndConfirmWithRetry so a dropped send self-heals
  // with a fresh blockhash; KEEP the existing poll.
  const migrateIx = await program.methods
    .migrateV4ToV5({})
    .accountsPartial({
      vault: vaultPda,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  try {
    await sendAndConfirmWithRetry(provider, [migrateIx]);
  } catch (err: any) {
    // A resend after a transient drop can revert because the FIRST send actually
    // landed (vault already V5). Confirm via the poll rather than the revert text:
    // if the vault is V5 the migrate succeeded; otherwise the error is real.
    const v: any = await program.account.vault.fetch(vaultPda).catch(() => null);
    if (!v || v.version !== 5) throw err;
  }

  await pollUntilAccount(
    () => program.account.vault.fetch(vaultPda),
    (v: any) => v.version === 5,
  );
}

/**
 * (b2) Migrate a V5 vault to V6 via migrate_v5_to_v6 (the no-session path —
 * the V6 multi-session model has no legacy active_session to lift), then poll
 * until the on-chain `version` field reads 6. Chain this AFTER migrateVaultToV5
 * (V4 → V5 → V6) to land a vault the V6 register_session_key gate accepts.
 *
 * VERSION-AWARE: initialize_vault now stamps fresh vaults V6 directly, so on a
 * just-bootstrapped vault this is a no-op (already at the target). Only
 * genuine V5 waypoint vaults (pre-fix accounts mid-chain) still migrate.
 */
export async function migrateVaultToV6(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
): Promise<void> {
  // Raw version byte (data[8]) — see migrateVaultToV5 for why not the IDL decoder.
  const info = await provider.connection.getAccountInfo(vaultPda);
  if (info && info.data.length > 8 && info.data[8] >= 6) return; // already at target
  // Same self-heal pattern as migrateVaultToV5: route through
  // sendAndConfirmWithRetry (dropped send re-sends on a fresh blockhash), and
  // treat a revert-after-landed (vault already V6) as success via the poll.
  const migrateIx = await program.methods
    .migrateV5ToV6({})
    .accountsPartial({
      vault: vaultPda,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  try {
    await sendAndConfirmWithRetry(provider, [migrateIx]);
  } catch (err: any) {
    const v: any = await program.account.vault.fetch(vaultPda).catch(() => null);
    if (!v || v.version !== 6) throw err;
  }
  await pollUntilAccount(
    () => program.account.vault.fetch(vaultPda),
    (v: any) => v.version === 6,
  );
}

/**
 * (c) Enroll a FINANCIER credit vault: bootstrap a vault (born V6 since the
 * init fix; the trailing version-aware migrate-to-V5 hop is a no-op on it and
 * only fires for genuine pre-fix V4 accounts) with the draw_credit ProgramExec
 * marker on role 1. Credit instructions gate on V5 || V6, so both land usable.
 *
 * Marker placement rationale: draw_credit's SignV2 spends the FINANCIER's
 * swig_wallet ATA, so the draw_credit discriminator MUST be a ProgramExec
 * marker on the FINANCIER's swig. Setting it as the bootstrap
 * `programExecMarker` puts it on role 1 (the single role-1 ProgramExec the
 * bootstrap adds), which is the role drawCreditAtomic signs through. This is
 * the simplest correct path — no post-enrollment marker add needed.
 */
export async function enrollCreditVault(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { usdcFundingAmount: bigint; drawMarker?: Uint8Array },
): Promise<RegisterReadyVault> {
  const ready = await bootstrapForRegister(program, provider, {
    usdcFundingAmount: opts.usdcFundingAmount,
    programExecMarker: opts.drawMarker ?? DRAW_CREDIT_DISCRIMINATOR,
  });
  await migrateVaultToV5(program, provider, ready.vaultPda);
  return ready;
}

/**
 * (d) open_standby — the USER's passkey consents to a credit facility backed
 * by `financierSwig` up to `cap`. Atomic [precompile, open_standby] where the
 * precompile MUST be the immediately-preceding instruction (the handler reads
 * current_index - 1).
 */
export async function openStandby(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    userVaultPda: PublicKey;
    userPasskey: P256Keypair;
    financierSwig: PublicKey;
    cap: bigint;
  },
): Promise<void> {
  const { userVaultPda, userPasskey, financierSwig, cap } = args;

  const opMsg = buildOpenStandbyMessage(userVaultPda, financierSwig, cap);
  const signed = signOperationWithPasskey(userPasskey, opMsg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    userPasskey.publicKey,
    signed.signature,
    signed.precompileMessage,
  );

  const openStandbyIx = await program.methods
    .openStandby({
      cap: new anchor.BN(cap.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({
      vault: userVaultPda,
      financierSwig,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  // [precompile, open_standby] pair — resilient send + poll the RESULT (vault's
  // standby_cap now equals `cap` and standby_backer is this financier). On a
  // transient drop the poll confirms whether the first send landed (a blind
  // resubmit could revert on already-applied state); a real revert on the first
  // send propagates. Precompile order preserved (immediately before the vault
  // ix). open_standby doubles as resize, so the cap-equality predicate is exact
  // for both the initial open and a resize. Purely additive.
  await sendPrecompilePairResilient(
    provider,
    [precompileIx, openStandbyIx],
    async () => {
      const v: any = await program.account.vault.fetch(userVaultPda);
      return (
        v.standbyCap.toString() === cap.toString() &&
        v.standbyBacker !== null &&
        v.standbyBacker.equals(financierSwig)
      );
    },
  );
}

/**
 * (e) drawCreditAtomic — THE BORROW. Atomic
 *   [N]   vault::draw_credit  (cap guard, raises borrowed, arms recovery)
 *   [N+1] swig::SignV2(TransferChecked)  (financier swig_wallet ATA → seller)
 *
 * Mirrors settleLockedAtomic from locked-claim-settle.ts, but the swig is the
 * FINANCIER's and the marker is the draw_credit discriminator on role 1 (set
 * at bootstrap, NOT a post-enrollment role-2 add).
 */
export async function drawCreditAtomic(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    userVaultPda: PublicKey;
    financierSwig: PublicKey;
    financierSwigWalletAddress: PublicKey;
    financierSwigWalletAddrKit: ReturnType<typeof kitAddress>;
    mint: PublicKey;
    financierSourceAta: PublicKey;
    sellerAta: PublicKey;
    decimals: number;
    amount: bigint;
    recoveryWindowSeconds: bigint;
    dexterAuthority: PublicKey;
  },
): Promise<void> {
  const {
    userVaultPda,
    financierSwig,
    financierSwigWalletAddress,
    financierSwigWalletAddrKit,
    mint,
    financierSourceAta,
    sellerAta,
    decimals,
    amount,
    recoveryWindowSeconds,
    dexterAuthority,
  } = args;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = makeRateLimitedKitRpc(provider.connection.rpcEndpoint);

  const drawVaultIx = await program.methods
    .drawCredit({
      amount: new anchor.BN(amount.toString()),
      recoveryWindowSeconds: new anchor.BN(recoveryWindowSeconds.toString()),
    })
    .accountsPartial({
      financierSwig,
      financierSwigWalletAddress,
      vault: userVaultPda,
      dexterAuthority,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(financierSourceAta.toBase58()),
      mint: kitAddress(mint.toBase58()),
      destination: kitAddress(sellerAta.toBase58()),
      authority: financierSwigWalletAddrKit,
      amount,
      decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  );

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(financierSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("Financier swig not visible for sign");

  // Role 1 = draw_credit marker (set as the bootstrap programExecMarker on the
  // FINANCIER's swig). NOT role 2 — the settle test ADDED a second marker
  // post-enrollment; here the marker is already on the bootstrap role 1.
  const signKitIxs = await getSignInstructions(
    swigForSign,
    DRAW_CREDIT_MARKER_ROLE,
    [transferKitIx],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [drawVaultIx as any],
    },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  );
  await provider.sendAndConfirm(tx);
}

/**
 * (f) registerMarkerOnSwig — add a NEW ProgramExec authority (a fresh role) to
 * an existing swig, bound to the vault program + a given instruction
 * discriminator. Mirrors locked-claim-settle.ts::registerSettleLockedVoucherMarker
 * but generic over the discriminator, and RETURNS the new role index.
 *
 * The bootstrap key (role 0, manageAuthority) signs the add. Roles are appended
 * in order, so the new role index = (number of authorities BEFORE the add).
 * A fresh bootstrapForRegister swig has role 0 (manageAuthority) + role 1
 * (ProgramExec, the bootstrap marker) → the first registerMarkerOnSwig returns
 * role 2, the second returns role 3, and so on.
 *
 * Used for repay_credit / seize_collateral markers, which MUST live on the
 * USER's swig (their SignV2 spends the USER's swig_wallet ATA).
 */
export async function registerMarkerOnSwig(args: {
  provider: anchor.AnchorProvider;
  swigAddress: PublicKey;
  vaultProgramId: PublicKey;
  discriminator: Uint8Array;
}): Promise<number> {
  const { provider, swigAddress, vaultProgramId, discriminator } = args;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = makeRateLimitedKitRpc(provider.connection.rpcEndpoint);

  const swigForAdd = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58()),
  );
  if (!swigForAdd) throw new Error("Swig not visible for marker add");

  // The new role index is the count of authorities present before this add.
  // Swig.roles is the canonical authority list on the fetched swig object.
  const rolesBefore: any[] =
    (swigForAdd as any).roles ?? (swigForAdd as any).authorities ?? [];
  const newRoleIndex = rolesBefore.length;

  const vaultProgramIdBytes = Uint8Array.from(vaultProgramId.toBytes());
  const markerAuthority = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    discriminator,
  );
  const fullActions = Actions.set().all().get();

  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0,
    markerAuthority,
    fullActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) },
  );
  // Resilient send: a dropped-but-landed addAuthority is confirmed via a
  // role-count poll (role count must reach newRoleIndex + 1), NOT blindly
  // re-sent (which would append a duplicate role). Happy path is identical to
  // the original single-shot send.
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

/**
 * (g) repayCreditAtomic — THE PAYDOWN. Atomic
 *   [N]   vault::repay_credit  (clamps to borrowed, lowers it, clears deadline at 0)
 *   [N+1] swig::SignV2(TransferChecked)  (USER swig_wallet ATA → financier ATA)
 *
 * Mirrors drawCreditAtomic BUT the swig is the USER's, and the SignV2 routes
 * through the USER swig role carrying the repay_credit marker (registered via
 * registerMarkerOnSwig post-enrollment). The transfer amount is the CLAMPED
 * value = min(amount, borrowed); for a full repay the caller passes
 * amount = borrowed.
 */
export async function repayCreditAtomic(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    userVaultPda: PublicKey;
    userSwig: PublicKey;
    userSwigWalletAddress: PublicKey;
    userSwigWalletAddrKit: ReturnType<typeof kitAddress>;
    mint: PublicKey;
    userSourceAta: PublicKey;
    financierAta: PublicKey;
    decimals: number;
    amount: bigint;
    repayMarkerRole: number;
    dexterAuthority: PublicKey;
  },
): Promise<void> {
  const {
    userVaultPda,
    userSwig,
    userSwigWalletAddress,
    userSwigWalletAddrKit,
    mint,
    userSourceAta,
    financierAta,
    decimals,
    amount,
    repayMarkerRole,
    dexterAuthority,
  } = args;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = makeRateLimitedKitRpc(provider.connection.rpcEndpoint);

  const repayVaultIx = await program.methods
    .repayCredit({ amount: new anchor.BN(amount.toString()) })
    .accountsPartial({
      swig: userSwig,
      swigWalletAddress: userSwigWalletAddress,
      vault: userVaultPda,
      dexterAuthority,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(userSourceAta.toBase58()),
      mint: kitAddress(mint.toBase58()),
      destination: kitAddress(financierAta.toBase58()),
      authority: userSwigWalletAddrKit,
      amount,
      decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  );

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(userSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("User swig not visible for sign");

  const signKitIxs = await getSignInstructions(
    swigForSign,
    repayMarkerRole,
    [transferKitIx],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [repayVaultIx as any],
    },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  );
  await provider.sendAndConfirm(tx);
}

/**
 * (h) seizeCollateralAtomic — THE DEADLINE LIQUIDATION. Atomic
 *   [N]   vault::seize_collateral (after deadline: snapshots seized=borrowed, zeroes it)
 *   [N+1] swig::SignV2(TransferChecked)  (USER swig_wallet ATA → financier ATA)
 *
 * Same as repayCreditAtomic but no amount arg (the program seizes exactly the
 * borrowed snapshot). The caller passes `seized` = borrowed-before so the SignV2
 * transfers exactly that. USER swig; marker registered post-enrollment.
 */
export async function seizeCollateralAtomic(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  args: {
    userVaultPda: PublicKey;
    userSwig: PublicKey;
    userSwigWalletAddress: PublicKey;
    userSwigWalletAddrKit: ReturnType<typeof kitAddress>;
    mint: PublicKey;
    userSourceAta: PublicKey;
    financierAta: PublicKey;
    decimals: number;
    seized: bigint;
    seizeMarkerRole: number;
    dexterAuthority: PublicKey;
  },
): Promise<void> {
  const {
    userVaultPda,
    userSwig,
    userSwigWalletAddress,
    userSwigWalletAddrKit,
    mint,
    userSourceAta,
    financierAta,
    decimals,
    seized,
    seizeMarkerRole,
    dexterAuthority,
  } = args;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = makeRateLimitedKitRpc(provider.connection.rpcEndpoint);

  const seizeVaultIx = await program.methods
    .seizeCollateral({})
    .accountsPartial({
      swig: userSwig,
      swigWalletAddress: userSwigWalletAddress,
      vault: userVaultPda,
      dexterAuthority,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(userSourceAta.toBase58()),
      mint: kitAddress(mint.toBase58()),
      destination: kitAddress(financierAta.toBase58()),
      authority: userSwigWalletAddrKit,
      amount: seized,
      decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS },
  );

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(userSwig.toBase58()),
  );
  if (!swigForSign) throw new Error("User swig not visible for sign");

  const signKitIxs = await getSignInstructions(
    swigForSign,
    seizeMarkerRole,
    [transferKitIx],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [seizeVaultIx as any],
    },
  );
  const signWeb3Ixs: TransactionInstruction[] = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs,
  );
  await provider.sendAndConfirm(tx);
}

/** Convenience: read an SPL token account amount at finalized commitment. */
export async function ataAmount(
  provider: anchor.AnchorProvider,
  ata: PublicKey,
): Promise<bigint> {
  const acct = await getAccount(provider.connection, ata, "finalized");
  return acct.amount;
}
