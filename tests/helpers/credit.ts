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
} from "./secp256r1";
import { fetchSwig, getSignInstructions } from "@swig-wallet/kit";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// draw_credit's Anchor discriminator — sha256("global:draw_credit")[..8].
// This is the ProgramExec marker that lets the [N+1] swig::SignV2 in the
// draw atomic flow validate against the FINANCIER swig's on-chain marker list.
export const DRAW_CREDIT_DISCRIMINATOR = new Uint8Array([
  20, 84, 47, 211, 78, 117, 195, 210,
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
 */
export async function migrateVaultToV5(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
): Promise<void> {
  await program.methods
    .migrateV4ToV5({})
    .accountsPartial({
      vault: vaultPda,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await pollUntilAccount(
    () => program.account.vault.fetch(vaultPda),
    (v: any) => v.version === 5,
  );
}

/**
 * (c) Enroll a FINANCIER credit vault: bootstrap a V4 vault with the
 * draw_credit ProgramExec marker on role 1, then migrate it to V5.
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

  await provider.sendAndConfirm(
    new Transaction().add(precompileIx, openStandbyIx),
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
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

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
