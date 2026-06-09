// register_session_key — overcommit invariant (V0.3 Decision 1, Task 8).
//
// Proves the new gate in register_session_key:
//
//   require!(args.max_amount + vault.outstanding_locked_amount
//            <= vault_usdc_ata.amount, SessionWouldOvercommitVault)
//
// vault_usdc_ata.amount is a LIVE token-account read; the ATA's owner is
// cross-checked against the canonical swig wallet PDA so a caller cannot
// smuggle an unrelated funded ATA into the gate.
//
// Build-only: these tests cannot pass until the combined Phase 1 deploy
// lands. The expected pre-deploy block is `InstructionFallbackNotFound`
// (custom error 0x65) on the modified register_session_key discriminator,
// because the live program still has the old account list.
//
// Both cases drive a real on-chain flow up through lock_voucher (to seed
// vault.outstanding_locked_amount > 0) and a passkey-signed revoke (to
// clear SessionAlreadyActive), then attempt a second register_session_key
// whose `max_amount + outstanding_locked_amount` is or is not within the
// live ATA balance. Per the brief, the only difference between the two
// cases is the max_amount of the second session.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { expect } from "chai";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  sessionRevokeMessage,
  makeTestProvider,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";

// 44-byte voucher payload — matches lock_voucher.rs (channel_id ||
// cumulative_amount u64-LE || sequence_number u32-LE).
function voucherPayloadMessage(
  channelId: Uint8Array,
  cumulativeAmount: bigint,
  sequenceNumber: number,
): Uint8Array {
  if (channelId.length !== 32) throw new Error("channelId must be 32 bytes");
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  buf.set(channelId, 0);
  view.setBigUint64(32, cumulativeAmount, true);
  view.setUint32(40, sequenceNumber >>> 0, true);
  return buf;
}

// Drive the chain through: open tab → lock voucher (so
// outstanding_locked_amount > 0) → passkey-signed revoke (so a second
// register_session_key isn't blocked by SessionAlreadyActive).
async function lockAndRevoke(args: {
  program: Program<DexterVault>;
  provider: anchor.AnchorProvider;
  vaultPda: PublicKey;
  passkey: { privateKey: Uint8Array; publicKey: Uint8Array };
  sessionKeypair: Keypair;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  sourceAta: PublicKey;
  /** V6: counterparty the session is bound to + the per-counterparty
   *  SessionAccount PDA (the session moved off vault.active_session in V6).
   *  settle_voucher / lock_voucher / revoke_session_key all need both. */
  allowedCounterparty: PublicKey;
  sessionPda: PublicKey;
  /** Both the open-tab amount and the voucher's cumulative_amount.
   *  After lock, vault.outstanding_locked_amount = amount. */
  amount: bigint;
}): Promise<void> {
  const {
    program,
    provider,
    vaultPda,
    passkey,
    sessionKeypair,
    swigAddress,
    swigWalletAddress,
    sourceAta,
    allowedCounterparty,
    sessionPda,
    amount,
  } = args;

  // (1) open tab: settle_voucher(increment=true, amount)
  await program.methods
    .settleVoucher({
      amount: new anchor.BN(amount.toString()),
      increment: true,
      allowedCounterparty,
    })
    .accountsPartial({
      vault: vaultPda,
      session: sessionPda,
      dexterAuthority: provider.wallet.publicKey,
    })
    .rpc();

  // (2) session signs a voucher; Ed25519 precompile + lock_voucher graduates
  //     `amount` from session.current_outstanding to
  //     vault.outstanding_locked_amount.
  const channelId = vaultPda.toBytes();
  const cumulativeAmount = amount;
  const sequenceNumber = 1;
  const voucherMessage = voucherPayloadMessage(
    channelId,
    cumulativeAmount,
    sequenceNumber,
  );
  const precompileIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: sessionKeypair.secretKey,
    message: voucherMessage,
  });
  const voucherHash = sha256(voucherMessage);

  const [claimPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("locked-claim"),
      vaultPda.toBytes(),
      Buffer.from(voucherHash),
    ],
    program.programId,
  );

  const lockIx = await program.methods
    .lockVoucher({
      channelId: Array.from(channelId),
      cumulativeAmount: new anchor.BN(cumulativeAmount.toString()),
      sequenceNumber,
      voucherHash: Array.from(voucherHash),
      maturityAt: null,
      holderRecoveryAt: null,
      allowedCounterparty,
    })
    .accountsPartial({
      vault: vaultPda,
      vaultUsdcAta: sourceAta,
      swig: swigAddress,
      swigWalletAddress,
      session: sessionPda,
      claim: claimPda,
      sellerHolder: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await provider.sendAndConfirm(
    new Transaction().add(precompileIx, lockIx),
  );

  // (3) passkey-signed revoke clears active_session so the second
  //     register_session_key isn't blocked by SessionAlreadyActive. The
  //     overcommit gate fires AFTER that check — leaving the prior session
  //     active would mask the gate behind a different error.
  const revokeMsg = sessionRevokeMessage({
    programId: program.programId,
    vaultPda,
    sessionPubkey: sessionKeypair.publicKey.toBytes(),
  });
  const revokeSigned = signOperationWithPasskey(passkey as any, revokeMsg);
  const revokePrecompile = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    revokeSigned.signature,
    revokeSigned.precompileMessage,
  );
  const revokeIx = await program.methods
    .revokeSessionKey({
      allowedCounterparty,
      clientDataJson: Buffer.from(revokeSigned.clientDataJSON),
      authenticatorData: Buffer.from(revokeSigned.authenticatorData),
    })
    .accountsPartial({
      vault: vaultPda,
      session: sessionPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await provider.sendAndConfirm(
    new Transaction().add(revokePrecompile, revokeIx),
  );
}

describe("register_session_key — overcommit gate (V0.3 Decision 1, Task 8)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(
    workspaceProgram.idl,
    provider,
  );

  it("rejects a new session whose max_amount + outstanding_locked_amount exceeds vault USDC balance", async () => {
    // Vault funded $10. First session opens + locks $5 (so
    // outstanding_locked_amount = $5). Revoke. Attempt a second register with
    // max_amount=$7 → combined 7+5 = 12 > 10. REJECT with
    // SessionWouldOvercommitVault.
    const FUND = 10_000_000n;
    const FIRST_CAP = 5_000_000n;
    const LOCK_AMOUNT = 5_000_000n;
    const SECOND_CAP_OVER = 7_000_000n;

    const bootstrap = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const first = await registerSessionV2(program, provider, {
      vaultPda: bootstrap.vaultPda,
      passkey: bootstrap.passkey,
      vaultUsdcAta: bootstrap.sourceAta,
      swigAddress: bootstrap.swigAddress,
      swigWalletAddress: bootstrap.swigWalletAddress,
      maxAmount: FIRST_CAP,
      maxRevolvingCapacity: FIRST_CAP,
    });

    await lockAndRevoke({
      program,
      provider,
      vaultPda: bootstrap.vaultPda,
      passkey: bootstrap.passkey,
      sessionKeypair: first.sessionKeypair,
      swigAddress: bootstrap.swigAddress,
      swigWalletAddress: bootstrap.swigWalletAddress,
      sourceAta: bootstrap.sourceAta,
      allowedCounterparty: first.allowedCounterparty,
      sessionPda: first.sessionPda,
      amount: LOCK_AMOUNT,
    });

    try {
      await registerSessionV2(program, provider, {
        vaultPda: bootstrap.vaultPda,
        passkey: bootstrap.passkey,
        vaultUsdcAta: bootstrap.sourceAta,
        swigAddress: bootstrap.swigAddress,
        swigWalletAddress: bootstrap.swigWalletAddress,
        maxAmount: SECOND_CAP_OVER,
        maxRevolvingCapacity: SECOND_CAP_OVER,
        nonce: 2,
      });
      expect.fail("expected SessionWouldOvercommitVault");
    } catch (err: any) {
      expect(err.toString()).to.match(/SessionWouldOvercommitVault/);
    }
  });

  it("permits a new session whose max_amount + outstanding_locked_amount fits within vault USDC balance", async () => {
    // Vault funded $10. First session opens + locks $5 (so
    // outstanding_locked_amount = $5). Revoke. Attempt a second register with
    // max_amount=$4 → combined 4+5 = 9 ≤ 10. SUCCESS.
    const FUND = 10_000_000n;
    const FIRST_CAP = 5_000_000n;
    const LOCK_AMOUNT = 5_000_000n;
    const SECOND_CAP_SAFE = 4_000_000n;

    const bootstrap = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUND,
      migrateTo: 6,
    });

    const first = await registerSessionV2(program, provider, {
      vaultPda: bootstrap.vaultPda,
      passkey: bootstrap.passkey,
      vaultUsdcAta: bootstrap.sourceAta,
      swigAddress: bootstrap.swigAddress,
      swigWalletAddress: bootstrap.swigWalletAddress,
      maxAmount: FIRST_CAP,
      maxRevolvingCapacity: FIRST_CAP,
    });

    await lockAndRevoke({
      program,
      provider,
      vaultPda: bootstrap.vaultPda,
      passkey: bootstrap.passkey,
      sessionKeypair: first.sessionKeypair,
      swigAddress: bootstrap.swigAddress,
      swigWalletAddress: bootstrap.swigWalletAddress,
      sourceAta: bootstrap.sourceAta,
      allowedCounterparty: first.allowedCounterparty,
      sessionPda: first.sessionPda,
      amount: LOCK_AMOUNT,
    });

    const second = await registerSessionV2(program, provider, {
      vaultPda: bootstrap.vaultPda,
      passkey: bootstrap.passkey,
      vaultUsdcAta: bootstrap.sourceAta,
      swigAddress: bootstrap.swigAddress,
      swigWalletAddress: bootstrap.swigWalletAddress,
      maxAmount: SECOND_CAP_SAFE,
      maxRevolvingCapacity: SECOND_CAP_SAFE,
      nonce: 2,
    });
    expect(second.signature).to.be.a("string");
  });
});
