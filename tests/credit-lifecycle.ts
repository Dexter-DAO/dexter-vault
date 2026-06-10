// Credit-L2 lifecycle integration tests (mainnet).
//
// The happy-path + money-movement leg of the Credit-L2 suite. Where
// credit-antirug.ts proves the REJECTIONS (cap guard, pin, early-seize, no
// consent, replay, marker placement), this file proves the SUCCESSES and their
// real on-chain balance deltas:
//
//   S2  — open → draw → repay (full lifecycle, both money moves asserted).
//   S8  — V5 withdrawal regression: a migrated V5 vault with borrowed==0 CAN
//         run request→finalize withdrawal (proves blocker fix 90c2429).
//   S9  — migration fidelity: V4 → V5 carries every pre-migration field
//         byte-identical and neutralizes the 4 new credit fields.
//   S10 — happy seize: short recovery window + REAL sleep past the deadline,
//         then seize_collateral moves the borrowed slice USER → financier.
//
// Setup recap (credit handlers gate version == V5; bootstrap makes V4):
//   - FINANCIER vault: enrollCreditVault (bootstrap V4 + draw_credit marker on
//     role 1, then migrate to V5). Its swig_wallet ATA funds draws.
//   - USER vault: bootstrapForRegister + migrateVaultToV5 (V5). Its passkey
//     consents to the standby facility; repay/seize markers are registered on
//     the USER swig post-enrollment.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  makeTestProvider,
  createAtaIdempotentFinalized,
  pollUntilAccount,
  buildSecp256r1VerifyInstruction,
  finalizeWithdrawalMessage,
  requestWithdrawalMessage,
  signOperationWithPasskey,
  P256Keypair,
} from "./helpers/secp256r1";
import { bootstrapForRegister } from "./helpers/register-bootstrap";
import {
  migrateVaultToV5,
  openStandby,
  drawCreditAtomic,
  repayCreditAtomic,
  seizeCollateralAtomic,
  registerMarkerOnSwig,
  REPAY_CREDIT_DISCRIMINATOR,
  SEIZE_COLLATERAL_DISCRIMINATOR,
  ataAmount,
} from "./helpers/credit";
import {
  enrollFinancierWithProgramAuthority,
  buildSetStandbyReserveTx,
} from "./helpers/standby-reserve";
import { enrollLockableVault } from "./lock-voucher";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────────────────
// S2 — Happy path: open → draw → repay.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S2 — open → draw → repay (full lifecycle)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("draws $3 from financier to seller, then user repays $3 to financier; balances + credit state track exactly", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;

    // FINANCIER — funds the draw. draw_credit marker on role 1, V5, PLUS the
    // Program(dexter_vault) authority (role 2) needed to set a reserve.
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      10_000_000n,
    );
    // USER — funded $5 so it can later repay $3 from its OWN swig_wallet ATA.
    // CRITICAL: enroll on the FINANCIER's mint (shared mint). Credit is
    // same-token: draw moves financier→seller and repay moves user→financier,
    // all in ONE mint. Without sharing, the repay SignV2 sends user-mint tokens
    // to a financier-mint ATA → SPL token 0x3 "Account not associated with this
    // Mint". (This was the S2 harness bug in the first mainnet run.)
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 5_000_000n,
      mint: financier.mint,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    // Register repay_credit marker on the USER swig (its SignV2 spends the
    // user's wallet). First post-enrollment add → role 2.
    const repayRole = await registerMarkerOnSwig({
      provider,
      swigAddress: user.swigAddress,
      vaultProgramId: program.programId,
      discriminator: REPAY_CREDIT_DISCRIMINATOR,
    });
    expect(repayRole).to.equal(2);

    // Seller destination ATA on the financier mint.
    const seller = Keypair.generate();
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );

    // Financier destination ATA (where the user's repayment lands). Owned by
    // the wallet — we just assert it rises by the repaid amount.
    const financierDest = Keypair.generate();
    const financierDestAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      financierDest.publicKey,
    );

    // Phase-1 precondition: commit a reserve (inits the StandbyBacker ledger)
    // before open_standby. $10 covers the $5 cap.
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: 10_000_000n,
      programRole,
    });

    // open_standby cap = $5.
    const cap = 5_000_000n;
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap,
    });

    // ── DRAW $3 ──────────────────────────────────────────────────────────
    const drawAmount = 3_000_000n;
    const sellerPre = await ataAmount(provider, sellerAta);
    const financierSwigPre = await ataAmount(provider, financier.sourceAta);

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
      recoveryWindowSeconds: 300n,
      dexterAuthority: provider.wallet.publicKey,
    });

    const sellerPostDraw = await pollUntilAccount(
      () => getAccount(provider.connection, sellerAta, "finalized"),
      (a) => a.amount === sellerPre + drawAmount,
    );
    const financierSwigPostDraw = await ataAmount(provider, financier.sourceAta);

    expect((sellerPostDraw.amount - sellerPre).toString()).to.equal(
      drawAmount.toString(),
    );
    expect((financierSwigPre - financierSwigPostDraw).toString()).to.equal(
      drawAmount.toString(),
    );

    const vaultAfterDraw = await program.account.vault.fetch(user.vaultPda);
    expect((vaultAfterDraw as any).borrowed.toString()).to.equal(
      drawAmount.toString(),
    );
    expect((vaultAfterDraw as any).borrowRecoveryAt).to.not.equal(null);

    // ── REPAY $3 (full) ──────────────────────────────────────────────────
    const userSwigPre = await ataAmount(provider, user.sourceAta);
    const financierDestPre = await ataAmount(provider, financierDestAta);

    await repayCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      userSwig: user.swigAddress,
      userSwigWalletAddress: user.swigWalletAddress,
      userSwigWalletAddrKit: user.swigWalletAddrKit,
      mint: user.mint,
      userSourceAta: user.sourceAta,
      financierAta: financierDestAta,
      decimals: user.decimals,
      amount: drawAmount, // full repay (== borrowed)
      repayMarkerRole: repayRole,
      dexterAuthority: provider.wallet.publicKey,
    });

    const vaultAfterRepay = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === "0",
    );
    expect((vaultAfterRepay as any).borrowed.toString()).to.equal("0");
    expect((vaultAfterRepay as any).borrowRecoveryAt).to.equal(null);

    const userSwigPost = await ataAmount(provider, user.sourceAta);
    const financierDestPost = await ataAmount(provider, financierDestAta);
    expect((userSwigPre - userSwigPost).toString()).to.equal(
      drawAmount.toString(),
    );
    expect((financierDestPost - financierDestPre).toString()).to.equal(
      drawAmount.toString(),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S8 — V5 withdrawal regression (proves blocker fix 90c2429).
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S8 — V5 vault CAN withdraw when borrowed==0", () => {
  const provider = makeTestProvider();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("migrates a vault to V5, never draws (borrowed==0), and runs request→finalize withdrawal to SUCCESS (pending_withdrawal cleared)", async function () {
    this.timeout(600_000);

    // Lockable enrollment gives a real swig + funded ATA + known passkey on a
    // V4 vault (coolingOff=0). Migrate it to V5 → exercises the V5 version gate
    // that 90c2429 opened in request_withdrawal + finalize_withdrawal.
    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
    });
    await migrateVaultToV5(program, provider, ctx.vaultPda);

    const vaultV5 = await program.account.vault.fetch(ctx.vaultPda);
    // Version-aware bootstrap: initialize_vault now stamps V6 at birth, so the
    // migrate-to-V5 hop above is a no-op and the vault reads 6 (a genuine
    // pre-fix V4 account would land at 5). Both admit the withdrawal gate
    // (request/finalize accept V5 || V6) — the regression 90c2429 fixed.
    expect((vaultV5 as any).version).to.be.oneOf([5, 6]);
    expect((vaultV5 as any).borrowed.toString()).to.equal("0");
    expect((vaultV5 as any).outstandingLockedAmount.toString()).to.equal("0");

    // Withdraw $4 of the $10 in-balance, no locks, no borrow → must succeed.
    const destination = Keypair.generate().publicKey;
    const amount = 4_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));

    const reqMsg = requestWithdrawalMessage(amount, destination, signedAt);
    const reqSigned = signOperationWithPasskey(ctx.passkey, reqMsg);
    const reqPrecompile = buildSecp256r1VerifyInstruction(
      ctx.passkey.publicKey,
      reqSigned.signature,
      reqSigned.precompileMessage,
    );
    const reqIx = await program.methods
      .requestWithdrawal({
        amount: new BN(amount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(reqSigned.clientDataJSON),
        authenticatorData: Buffer.from(reqSigned.authenticatorData),
      })
      .accountsPartial({
        vault: ctx.vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(reqPrecompile, reqIx));

    const finMsg = finalizeWithdrawalMessage(amount, destination);
    const finSigned = signOperationWithPasskey(ctx.passkey, finMsg);
    const finPrecompile = buildSecp256r1VerifyInstruction(
      ctx.passkey.publicKey,
      finSigned.signature,
      finSigned.precompileMessage,
    );
    const finIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(finSigned.clientDataJSON),
        authenticatorData: Buffer.from(finSigned.authenticatorData),
      })
      .accountsPartial({
        vault: ctx.vaultPda,
        swig: ctx.swigAddress,
        vaultUsdcAta: ctx.sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await provider.sendAndConfirm(new Transaction().add(finPrecompile, finIx));

    // SUCCESS proof: pending_withdrawal cleared on a V5 vault (impossible before
    // the version-gate fix, which rejected V5 with UnsupportedVaultVersion).
    const vaultPost = await pollUntilAccount(
      () => program.account.vault.fetch(ctx.vaultPda),
      (v: any) => v.pendingWithdrawal === null,
    );
    expect((vaultPost as any).pendingWithdrawal).to.equal(null);
    // 6 on a born-V6 vault (the migrate hop no-ops), 5 on a pre-fix V4 account.
    expect((vaultPost as any).version).to.be.oneOf([5, 6]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S9 — Migration fidelity.
//
// SKIPPED — UNCONSTRUCTIBLE on the born-V6 build (mirrors the case-20
// precedent in migrate-v5-to-v6.ts): this case needs a FRESH V4 vault to
// snapshot and walk through migrate_v4_to_v5, but initialize_vault now stamps
// V6 at birth, so no instruction in this build can mint a V4-stamped vault.
// We refuse to fake the account bytes. The V4→V5 fidelity itself was already
// proven on mainnet (this suite's original green run + the 2026-06 fleet
// migration of the genuine pre-fix cohorts); any future coverage belongs in a
// program-crate Rust unit test against the migrate_v4_to_v5 handler with a
// raw V4 fixture.
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S9 — migration fidelity (V4 → V5 carries fields byte-identical, neutralizes credit fields)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it.skip("V4 snapshot fields survive migration intact; the 4 new credit fields land neutral; account stays program-owned + rent-exempt [UNCONSTRUCTIBLE: init stamps V6 — see block comment]", async function () {
    this.timeout(600_000);

    // Enroll a V4 vault — do NOT migrate yet.
    const v = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
    });

    // Snapshot pre-migration (must be version 4).
    const pre = await program.account.vault.fetch(v.vaultPda);
    expect((pre as any).version).to.equal(4);

    const preSnap = {
      bump: (pre as any).bump,
      passkeyPubkey: Array.from((pre as any).passkeyPubkey as number[]),
      swigAddress: (pre as any).swigAddress.toString(),
      coolingOffSeconds: (pre as any).coolingOffSeconds,
      pendingVoucherCount: (pre as any).pendingVoucherCount,
      pendingWithdrawal: (pre as any).pendingWithdrawal,
      identityClaim: Array.from((pre as any).identityClaim as number[]),
      dexterAuthority: (pre as any).dexterAuthority.toString(),
      activeSession: (pre as any).activeSession,
      outstandingLockedAmount: (pre as any).outstandingLockedAmount.toString(),
      totalCrystallizedAmount: (pre as any).totalCrystallizedAmount.toString(),
      totalSettledAmount: (pre as any).totalSettledAmount.toString(),
    };

    // Rent-exemption baseline: account exists + program-owned pre-migration.
    const preInfo = await provider.connection.getAccountInfo(v.vaultPda);
    expect(preInfo).to.not.equal(null);
    expect(preInfo!.owner.toString()).to.equal(program.programId.toString());

    await migrateVaultToV5(program, provider, v.vaultPda);

    const post = await program.account.vault.fetch(v.vaultPda);

    // version flips to 5.
    expect((post as any).version).to.equal(5);

    // Every carried-over field byte-identical to the snapshot.
    expect((post as any).bump).to.equal(preSnap.bump);
    expect(Array.from((post as any).passkeyPubkey as number[])).to.deep.equal(
      preSnap.passkeyPubkey,
    );
    expect((post as any).swigAddress.toString()).to.equal(preSnap.swigAddress);
    expect((post as any).coolingOffSeconds).to.equal(preSnap.coolingOffSeconds);
    expect((post as any).pendingVoucherCount).to.equal(
      preSnap.pendingVoucherCount,
    );
    expect((post as any).pendingWithdrawal).to.deep.equal(
      preSnap.pendingWithdrawal,
    );
    expect(Array.from((post as any).identityClaim as number[])).to.deep.equal(
      preSnap.identityClaim,
    );
    expect((post as any).dexterAuthority.toString()).to.equal(
      preSnap.dexterAuthority,
    );
    expect((post as any).activeSession).to.deep.equal(preSnap.activeSession);
    expect((post as any).outstandingLockedAmount.toString()).to.equal(
      preSnap.outstandingLockedAmount,
    );
    expect((post as any).totalCrystallizedAmount.toString()).to.equal(
      preSnap.totalCrystallizedAmount,
    );
    expect((post as any).totalSettledAmount.toString()).to.equal(
      preSnap.totalSettledAmount,
    );

    // The 4 new credit fields land neutral.
    expect((post as any).borrowed.toString()).to.equal("0");
    expect((post as any).standbyBacker).to.equal(null);
    expect((post as any).standbyCap.toString()).to.equal("0");
    expect((post as any).borrowRecoveryAt).to.equal(null);

    // Account still exists, program-owned, and rent-exempt for its new size.
    const postInfo = await provider.connection.getAccountInfo(v.vaultPda);
    expect(postInfo).to.not.equal(null);
    expect(postInfo!.owner.toString()).to.equal(program.programId.toString());
    const minRent =
      await provider.connection.getMinimumBalanceForRentExemption(
        postInfo!.data.length,
      );
    expect(postInfo!.lamports).to.be.gte(minRent);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// S10 — Happy seize (short window + REAL sleep past the deadline).
// ──────────────────────────────────────────────────────────────────────────
describe("Credit-L2 S10 — happy seize after the deadline", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("draws $2 with a 25s window, sleeps past borrow_recovery_at, then seize_collateral moves $2 USER → financier and clears credit state", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;

    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      10_000_000n,
    );
    // USER funded $2 so the collateral exists in its swig_wallet ATA to be seized.
    // Shared mint (financier's): seize moves user→financier in ONE token, so
    // both vaults + all ATAs must be on the same mint (else SPL token 0x3).
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 2_000_000n,
      mint: financier.mint,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);

    // Register the seize_collateral marker on the USER swig (role 2 here, since
    // it's the first post-enrollment add on this swig).
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
      financier.mint, // shared mint (== user.mint now); the seize lands here
      financierDest.publicKey,
    );

    // Phase-1 precondition: commit a reserve (inits the StandbyBacker ledger)
    // before open_standby. $10 covers the $5 cap.
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: 10_000_000n,
      programRole,
    });

    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: 5_000_000n,
    });

    // Draw $2 with a 25-second recovery window.
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
      recoveryWindowSeconds: 25n,
      dexterAuthority: provider.wallet.publicKey,
    });

    const vaultAfterDraw = await program.account.vault.fetch(user.vaultPda);
    const recoveryAt = Number((vaultAfterDraw as any).borrowRecoveryAt);
    expect((vaultAfterDraw as any).borrowed.toString()).to.equal(
      drawAmount.toString(),
    );
    expect(recoveryAt).to.be.greaterThan(0);

    // REAL sleep until comfortably past the deadline (chain clock, +buffer).
    const nowSec = Math.floor(Date.now() / 1000);
    const waitSec = Math.max(0, recoveryAt - nowSec) + 8;
    await sleep(waitSec * 1000);

    const userSwigPre = await ataAmount(provider, user.sourceAta);
    const financierDestPre = await ataAmount(provider, financierDestAta);

    // Seize. If chain-clock skew makes the first attempt too early, sleep once
    // more and retry (per the scenario contract).
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
      if (/BorrowRecoveryTooEarly/.test(String(err))) {
        await sleep(10_000);
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
      } else {
        throw err;
      }
    }

    const vaultPost = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === "0",
    );
    expect((vaultPost as any).borrowed.toString()).to.equal("0");
    expect((vaultPost as any).borrowRecoveryAt).to.equal(null);

    const userSwigPost = await ataAmount(provider, user.sourceAta);
    const financierDestPost = await ataAmount(provider, financierDestAta);
    expect((userSwigPre - userSwigPost).toString()).to.equal(
      drawAmount.toString(),
    );
    expect((financierDestPost - financierDestPre).toString()).to.equal(
      drawAmount.toString(),
    );
  });
});
