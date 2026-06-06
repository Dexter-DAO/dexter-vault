// Credit-L2 anti-rug integration tests (mainnet).
//
// STAGE 1 — ONE proof scenario: the cap guard. draw_credit's anti-rug core is
// the ceiling check `borrowed + amount <= standby_cap` in draw_credit.rs. A
// draw that would push borrowed past the configured standby_cap MUST be
// rejected with CreditWouldExceedStandbyCap and move no money.
//
// Setup recap (credit handlers gate version == V5; bootstrap makes V4):
//   - FINANCIER vault: enrollCreditVault (bootstrap V4 + draw_credit marker on
//     role 1, then migrate to V5). Its swig_wallet ATA funds the draw.
//   - USER vault: bootstrapForRegister + migrateVaultToV5 (V5). Its passkey
//     consents to the standby facility; its dexter_authority == provider wallet.
//   - open_standby on the USER vault: cap = $5, backer = financier swig.
//   - draw_credit attempt for $6 (> cap) → must throw CreditWouldExceedStandbyCap.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  makeTestProvider,
  createAtaIdempotentFinalized,
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  requestWithdrawalMessage,
  finalizeWithdrawalMessage,
  pollUntilAccount,
} from "./helpers/secp256r1";
import { getAccount } from "@solana/spl-token";
import { bootstrapForRegister } from "./helpers/register-bootstrap";
import {
  enrollCreditVault,
  migrateVaultToV5,
  openStandby,
  drawCreditAtomic,
  seizeCollateralAtomic,
  registerMarkerOnSwig,
  buildOpenStandbyMessage,
  ataAmount,
  SEIZE_COLLATERAL_DISCRIMINATOR,
  REPAY_CREDIT_DISCRIMINATOR,
  DRAW_CREDIT_DISCRIMINATOR,
  DRAW_CREDIT_MARKER_ROLE,
} from "./helpers/credit";
import { enrollLockableVault, buildLockVoucherIx, buildSessionSignedVoucher } from "./lock-voucher";
import {
  fetchSwig,
  getSignInstructions,
} from "@swig-wallet/kit";
import { SolInstruction } from "@swig-wallet/lib";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    const sol = SolInstruction.from(ix);
    const web3 = sol.toWeb3Instruction();
    return {
      programId: new PublicKey(web3.programId.toBase58()),
      keys: web3.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey.toBase58()),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(web3.data),
    } as TransactionInstruction;
  });
}

describe("draw_credit — cap guard", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("draw past cap rejected (CreditWouldExceedStandbyCap)", async function () {
    this.timeout(600_000);

    // FINANCIER vault — funds the draw. draw_credit marker on role 1, V5.
    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n, // $10 available to lend
    });

    // USER vault — receives the standby facility. Bootstrap V4 → migrate V5.
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    // Fresh seller destination ATA on the financier's mint.
    const seller = Keypair.generate();
    const wallet = (provider.wallet as anchor.Wallet).payer;
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );

    // User consents to a $5 standby cap backed by the financier swig.
    const cap = 5_000_000n; // $5
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap,
    });

    // Sanity: the facility landed (standby_cap == $5, backer set, borrowed 0).
    const vaultMid = await program.account.vault.fetch(user.vaultPda);
    expect((vaultMid as any).standbyCap.toString()).to.equal(cap.toString());
    expect((vaultMid as any).standbyBacker.toString()).to.equal(
      financier.swigAddress.toString(),
    );
    expect((vaultMid as any).borrowed.toString()).to.equal("0");

    // Attempt to draw $6 (> $5 cap). Must be rejected by the cap guard.
    let threw = false;
    let errStr = "";
    try {
      await drawCreditAtomic(program, provider, {
        userVaultPda: user.vaultPda,
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        financierSwigWalletAddrKit: financier.swigWalletAddrKit,
        mint: financier.mint,
        financierSourceAta: financier.sourceAta,
        sellerAta,
        decimals: financier.decimals,
        amount: 6_000_000n, // $6 > $5 cap
        recoveryWindowSeconds: 60n,
        dexterAuthority: provider.wallet.publicKey,
      });
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
      expect(errStr).to.match(/CreditWouldExceedStandbyCap/);
    }
    expect(
      threw,
      "over-cap draw_credit should have been rejected (CreditWouldExceedStandbyCap)",
    ).to.equal(true);

    // borrowed must remain 0 — the rejected draw moved nothing.
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).borrowed.toString()).to.equal("0");
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────────────────
// S3 — withdraw below the borrow pin is rejected (WithdrawalWouldViolatePin).
//
// The pin lives in finalize_withdrawal: after the locked-amount reservation
// check, a SEPARATE require! enforces
//   live_balance_after >= outstanding_locked_amount + borrowed
// (finalize_withdrawal.rs:121-128). With outstanding_locked==0 and borrowed=B,
// any withdrawal that would leave the swig_wallet ATA below B must reject with
// WithdrawalWouldViolatePin. request_withdrawal has NO balance check (it only
// stages pending), so the breach surfaces at FINALIZE — exactly as the prompt
// notes.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S3 — withdraw below the borrow pin rejected (WithdrawalWouldViolatePin)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("draws $4 (pins $4 of user collateral), then a withdrawal that would breach the pin is rejected at finalize", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;

    // FINANCIER — funds the draw. draw_credit marker on role 1, V5.
    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    // USER — funded $5 in its OWN swig_wallet ATA. This is the live balance the
    // pin protects. coolingOff must be 0 so finalize can run immediately;
    // bootstrapForRegister vaults default to coolingOff 0.
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 5_000_000n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    // Seller destination ATA on the financier mint (draw target).
    const seller = Keypair.generate();
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );

    // open_standby cap = $5.
    const cap = 5_000_000n;
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap,
    });

    // Draw $4 → borrowed = $4, recovery window 300s (irrelevant to the pin).
    const borrowAmount = 4_000_000n;
    await drawCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      financierSwigWalletAddrKit: financier.swigWalletAddrKit,
      mint: financier.mint,
      financierSourceAta: financier.sourceAta,
      sellerAta,
      decimals: financier.decimals,
      amount: borrowAmount,
      recoveryWindowSeconds: 300n,
      dexterAuthority: provider.wallet.publicKey,
    });

    const vaultAfterDraw = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === borrowAmount.toString(),
    );
    expect((vaultAfterDraw as any).borrowed.toString()).to.equal(
      borrowAmount.toString(),
    );

    // The USER's swig_wallet ATA still holds its $5 (the draw spent the
    // FINANCIER's funds, not the user's). The pin floor is `borrowed` = $4, so
    // the withdrawable headroom is live_balance - borrowed = $5 - $4 = $1.
    const liveBalance = await ataAmount(provider, user.sourceAta);
    expect(liveBalance.toString()).to.equal("5000000");

    // Request a $2 withdrawal: live_balance - amount = $3 ≥ ... wait, that's
    // still ≥ $4? No: $5 - $2 = $3 < borrowed $4 → BREACH. Pick $2 so the
    // post-withdrawal balance ($3) sits BELOW the pinned $4.
    const withdrawAmount = 2_000_000n;
    expect(liveBalance - withdrawAmount < borrowAmount).to.equal(true); // breach
    const destination = Keypair.generate().publicKey;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    // request_withdrawal: no balance check, stages the pending withdrawal.
    const reqMsg = requestWithdrawalMessage(withdrawAmount, destination, signedAt);
    const reqSigned = signOperationWithPasskey(user.passkey, reqMsg);
    const reqPrecompile = buildSecp256r1VerifyInstruction(
      user.passkey.publicKey,
      reqSigned.signature,
      reqSigned.precompileMessage,
    );
    const reqIx = await program.methods
      .requestWithdrawal({
        amount: new BN(withdrawAmount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(reqSigned.clientDataJSON),
        authenticatorData: Buffer.from(reqSigned.authenticatorData),
      })
      .accountsPartial({
        vault: user.vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(reqPrecompile, reqIx));

    // Confirm the pending withdrawal is staged.
    const vaultStaged = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.pendingWithdrawal !== null,
    );
    expect((vaultStaged as any).pendingWithdrawal).to.not.equal(null);

    // finalize_withdrawal MUST reject with WithdrawalWouldViolatePin: the post-
    // withdrawal live balance ($3) is below outstanding_locked($0) + borrowed($4).
    const finMsg = finalizeWithdrawalMessage(withdrawAmount, destination);
    const finSigned = signOperationWithPasskey(user.passkey, finMsg);
    const finPrecompile = buildSecp256r1VerifyInstruction(
      user.passkey.publicKey,
      finSigned.signature,
      finSigned.precompileMessage,
    );
    const finIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(finSigned.clientDataJSON),
        authenticatorData: Buffer.from(finSigned.authenticatorData),
      })
      .accountsPartial({
        vault: user.vaultPda,
        swig: user.swigAddress,
        vaultUsdcAta: user.sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    let threw = false;
    let errStr = "";
    try {
      await provider.sendAndConfirm(
        new Transaction().add(finPrecompile, finIx),
      );
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
      expect(errStr).to.match(/WithdrawalWouldViolatePin/);
    }
    expect(
      threw,
      "pin-breaching finalize_withdrawal should reject (WithdrawalWouldViolatePin)",
    ).to.equal(true);
    console.log("    [S3] captured error:", errStr.split("\n")[0]);

    // The pin held: borrowed unchanged, withdrawal still pending (not cleared),
    // and the user's live balance untouched.
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).borrowed.toString()).to.equal(
      borrowAmount.toString(),
    );
    expect((vaultPost as any).pendingWithdrawal).to.not.equal(null);
    const livePost = await ataAmount(provider, user.sourceAta);
    expect(livePost.toString()).to.equal(liveBalance.toString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S4 — seize before the deadline is rejected (BorrowRecoveryTooEarly).
//
// seize_collateral.rs:131 — `require!(now >= deadline, BorrowRecoveryTooEarly)`
// runs BEFORE any state mutation. Draw with a long window (300s) and seize
// IMMEDIATELY → well before the deadline → must reject, move no money.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S4 — seize before deadline rejected (BorrowRecoveryTooEarly)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("draws $2 with a 300s window, then an immediate seize is rejected — nothing moves", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;

    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    // USER funded $2 so collateral exists in its swig_wallet ATA.
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 2_000_000n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    // seize_collateral marker on the USER swig (first post-enroll add → role 2).
    const seizeRole = await registerMarkerOnSwig({
      provider,
      swigAddress: user.swigAddress,
      vaultProgramId: program.programId,
      discriminator: SEIZE_COLLATERAL_DISCRIMINATOR,
    });
    expect(seizeRole).to.equal(2);

    const seller = Keypair.generate();
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );
    const financierDest = Keypair.generate();
    const financierDestAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      user.mint,
      financierDest.publicKey,
    );

    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: 5_000_000n,
    });

    const drawAmount = 2_000_000n;
    await drawCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      financierSwigWalletAddrKit: financier.swigWalletAddrKit,
      mint: financier.mint,
      financierSourceAta: financier.sourceAta,
      sellerAta,
      decimals: financier.decimals,
      amount: drawAmount,
      recoveryWindowSeconds: 300n, // 5 min — we seize immediately, far before it
      dexterAuthority: provider.wallet.publicKey,
    });

    const vaultAfterDraw = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === drawAmount.toString(),
    );
    const recoveryAt = Number((vaultAfterDraw as any).borrowRecoveryAt);
    expect(recoveryAt).to.be.greaterThan(Math.floor(Date.now() / 1000)); // future

    const userSwigPre = await ataAmount(provider, user.sourceAta);
    const financierDestPre = await ataAmount(provider, financierDestAta);

    // IMMEDIATE seize — we are well inside the 300s window → BorrowRecoveryTooEarly.
    let threw = false;
    let errStr = "";
    try {
      await seizeCollateralAtomic(program, provider, {
        userVaultPda: user.vaultPda,
        userSwig: user.swigAddress,
        userSwigWalletAddress: user.swigWalletAddress,
        userSwigWalletAddrKit: user.swigWalletAddrKit,
        mint: user.mint,
        userSourceAta: user.sourceAta,
        financierAta: financierDestAta,
        decimals: user.decimals,
        seized: drawAmount,
        seizeMarkerRole: seizeRole,
        dexterAuthority: provider.wallet.publicKey,
      });
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
      expect(errStr).to.match(/BorrowRecoveryTooEarly/);
    }
    expect(
      threw,
      "pre-deadline seize_collateral should reject (BorrowRecoveryTooEarly)",
    ).to.equal(true);
    console.log("    [S4] captured error:", errStr.split("\n")[0]);

    // Nothing moved, credit state intact.
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).borrowed.toString()).to.equal(
      drawAmount.toString(),
    );
    expect((vaultPost as any).borrowRecoveryAt).to.not.equal(null);
    const userSwigPost = await ataAmount(provider, user.sourceAta);
    const financierDestPost = await ataAmount(provider, financierDestAta);
    expect(userSwigPost.toString()).to.equal(userSwigPre.toString());
    expect(financierDestPost.toString()).to.equal(financierDestPre.toString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S5 — open_standby WITHOUT genuine user consent is rejected.
//
// We build the precompile with a DIFFERENT (random) P256 keypair: the
// precompile itself passes (sig matches ITS OWN pubkey), but
// verify_passkey_signed → introspect_simd_0075 checks
// `actual_pubkey == vault.passkey_pubkey` and the embedded pubkey is the random
// one, not the vault's → PasskeyVerificationFailed. Proves: a financier cannot
// attach standby backing without the user's genuine passkey.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S5 — open_standby without user consent rejected (PasskeyVerificationFailed)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("signs the open_standby op-message with a WRONG passkey; the vault rejects (no standby terms written)", async function () {
    this.timeout(600_000);

    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    const cap = 5_000_000n;
    const opMsg = buildOpenStandbyMessage(
      user.vaultPda,
      financier.swigAddress,
      cap,
    );

    // Sign with a WRONG keypair (an attacker who is NOT the vault owner).
    const wrongPasskey = generateP256Keypair();
    const signed = signOperationWithPasskey(wrongPasskey, opMsg);
    // Precompile carries the WRONG pubkey — it self-verifies fine, but the
    // on-chain introspection demands actual_pubkey == vault.passkey_pubkey.
    const precompileIx = buildSecp256r1VerifyInstruction(
      wrongPasskey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const openStandbyIx = await program.methods
      .openStandby({
        cap: new BN(cap.toString()),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: user.vaultPda,
        financierSwig: financier.swigAddress,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    let threw = false;
    let errStr = "";
    try {
      await provider.sendAndConfirm(
        new Transaction().add(precompileIx, openStandbyIx),
      );
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
      expect(errStr).to.match(/PasskeyVerificationFailed/);
    }
    expect(
      threw,
      "open_standby signed by a non-owner passkey should reject (PasskeyVerificationFailed)",
    ).to.equal(true);
    console.log("    [S5] captured error:", errStr.split("\n")[0]);

    // No standby terms were written — the facility never attached.
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).standbyBacker).to.equal(null);
    expect((vaultPost as any).standbyCap.toString()).to.equal("0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S6 — consent replay binding: a valid signature for financierA cannot be
// reused against financierB.
//
// The op-message binds vault+financier+cap; the WebAuthn challenge in
// clientDataJSON is sha256(op_message for financierA). open_standby rebuilds
// op_msg from the ACTUAL financier_swig account (financierB) and recomputes the
// expected challenge → it no longer matches the signed challenge →
// PasskeyVerificationFailed. The user genuinely consented, but to a DIFFERENT
// backer; the binding makes the consent non-transferable.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S6 — consent replay binding rejected (PasskeyVerificationFailed)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("a valid open_standby consent for financierA, replayed with financierB swapped in, is rejected", async function () {
    this.timeout(600_000);

    const financierA = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    const financierB = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    const cap = 5_000_000n;

    // VALID consent for financierA: sign op_msg(vault, financierA, cap).
    const opMsgA = buildOpenStandbyMessage(
      user.vaultPda,
      financierA.swigAddress,
      cap,
    );
    const signedA = signOperationWithPasskey(user.passkey, opMsgA);

    // Sanity: the same signature submitted against financierA WOULD succeed.
    // (We don't actually run it here — we only need to prove the replay fails.
    // The success path is already covered by S2.)

    // REPLAY: reuse the SAME signature / clientDataJSON / authenticatorData but
    // pass financierB as the financier_swig account. The challenge bound to
    // financierA no longer matches the on-chain op_msg(vault, financierB, cap).
    const precompileIx = buildSecp256r1VerifyInstruction(
      user.passkey.publicKey,
      signedA.signature,
      signedA.precompileMessage,
    );
    const openStandbyIx = await program.methods
      .openStandby({
        cap: new BN(cap.toString()),
        clientDataJson: Buffer.from(signedA.clientDataJSON),
        authenticatorData: Buffer.from(signedA.authenticatorData),
      })
      .accountsPartial({
        vault: user.vaultPda,
        financierSwig: financierB.swigAddress, // ← swapped backer
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    let threw = false;
    let errStr = "";
    try {
      await provider.sendAndConfirm(
        new Transaction().add(precompileIx, openStandbyIx),
      );
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
      expect(errStr).to.match(/PasskeyVerificationFailed/);
    }
    expect(
      threw,
      "consent bound to financierA replayed against financierB should reject (PasskeyVerificationFailed)",
    ).to.equal(true);
    console.log("    [S6] captured error:", errStr.split("\n")[0]);

    // No terms written for financierB.
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).standbyBacker).to.equal(null);
    expect((vaultPost as any).standbyCap.toString()).to.equal("0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S7 — whose-swig / marker placement is load-bearing (negative).
//
// draw_credit's [N+1] swig::SignV2 spends the FINANCIER swig_wallet ATA as a
// ProgramExec authority. Swig validates the ROLE used for SignV2 carries a
// ProgramExec marker whose discriminator matches the PRECEDING instruction's
// data prefix (the draw_credit discriminator). If we route SignV2 through a
// financier-swig role that carries a DIFFERENT marker (repay_credit), the
// discriminator does not match → Swig rejects the ProgramExec authority. The
// money never moves.
//
// What this proves precisely: the SignV2 succeeds ONLY through the role bearing
// the draw_credit marker on the swig whose wallet it spends. A role lacking that
// exact marker — even on the correct (financier) swig — cannot drive the draw.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S7 — draw signed through a role lacking the draw_credit marker fails", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("a draw whose SignV2 routes through a repay_credit marker role (not draw_credit) is rejected — nothing moves", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;

    // FINANCIER — has the draw_credit marker on role 1 (from enroll).
    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
    });
    // Add a SECOND marker on the FINANCIER swig for a DIFFERENT discriminator
    // (repay_credit) → role 2. We will deliberately sign the draw through THIS
    // wrong-marker role.
    const wrongRole = await registerMarkerOnSwig({
      provider,
      swigAddress: financier.swigAddress,
      vaultProgramId: program.programId,
      discriminator: REPAY_CREDIT_DISCRIMINATOR,
    });
    expect(wrongRole).to.equal(2);
    expect(wrongRole).to.not.equal(DRAW_CREDIT_MARKER_ROLE);

    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    const seller = Keypair.generate();
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );

    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: 5_000_000n,
    });

    const drawAmount = 2_000_000n;
    const financierSwigPre = await ataAmount(provider, financier.sourceAta);
    const sellerPre = await ataAmount(provider, sellerAta);

    // Build the draw atomic MANUALLY (mirroring drawCreditAtomic) but route the
    // SignV2 through `wrongRole` (repay_credit marker) instead of
    // DRAW_CREDIT_MARKER_ROLE. The preceding instruction is draw_credit, whose
    // discriminator does NOT match the repay_credit marker on this role.
    const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

    const drawVaultIx = await program.methods
      .drawCredit({
        amount: new BN(drawAmount.toString()),
        recoveryWindowSeconds: new BN("300"),
      })
      .accountsPartial({
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        vault: user.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const transferKitIx = getTransferCheckedInstruction(
      {
        source: kitAddress(financier.sourceAta.toBase58()),
        mint: kitAddress(financier.mint.toBase58()),
        destination: kitAddress(sellerAta.toBase58()),
        authority: financier.swigWalletAddrKit,
        amount: drawAmount,
        decimals: financier.decimals,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );

    const swigForSign = await fetchSwig(
      rpc as any,
      kitAddress(financier.swigAddress.toBase58()),
    );
    if (!swigForSign) throw new Error("Financier swig not visible for sign");

    let threw = false;
    let errStr = "";
    try {
      const signKitIxs = await getSignInstructions(
        swigForSign,
        wrongRole, // ← WRONG marker role (repay_credit, not draw_credit)
        [transferKitIx],
        false,
        {
          payer: kitAddress(wallet.publicKey.toBase58()),
          preInstructions: [drawVaultIx as any],
        },
      );
      const signWeb3Ixs = kitInstructionsToWeb3(signKitIxs);
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...signWeb3Ixs,
      );
      await provider.sendAndConfirm(tx);
    } catch (err: any) {
      threw = true;
      errStr = err.toString();
    }
    expect(
      threw,
      "draw signed through a role lacking the draw_credit marker should fail",
    ).to.equal(true);
    // Tighten to the SPECIFIC on-chain failure (set after capturing the real
    // string in the first mainnet run — see report).
    expect(errStr).to.match(
      /custom program error|PermissionDenied|Swig|InvalidAuthority|0x/,
    );
    console.log("    [S7] captured error:", errStr.split("\n")[0]);

    // Money never moved; borrowed never rose (the atomic tx reverted whole).
    const financierSwigPost = await ataAmount(provider, financier.sourceAta);
    const sellerPost = await ataAmount(provider, sellerAta);
    expect(financierSwigPost.toString()).to.equal(financierSwigPre.toString());
    expect(sellerPost.toString()).to.equal(sellerPre.toString());
    const vaultPost = await program.account.vault.fetch(user.vaultPda);
    expect((vaultPost as any).borrowed.toString()).to.equal("0");
  });
});
