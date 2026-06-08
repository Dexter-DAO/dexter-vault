// Phase 1 aggregate-reserve integration tests (mainnet).
//
// THE PRIMITIVE under test: a FINANCIER (identified by their swig) backs credit
// standby lines across MANY user vaults. A `StandbyBacker` PDA (one per
// financier swig, seed ["standby-backer", financierSwig]) holds:
//   - committed_reserve  — the cap the financier commits (set via set_standby_reserve)
//   - aggregate_promised — Σ of all standby caps promised across vaults
// The core invariant: aggregate_promised <= committed_reserve. A financier can
// never promise more standby capacity than they've reserved.
//
// Instructions exercised:
//   - set_standby_reserve(new_reserve) — financier sets/changes committed_reserve
//       (consent = mechanism B: the ix runs as the INNER CPI of the financier
//       swig's SignV2, which invoke_signed's the swig_wallet PDA as signer).
//       Lowering below aggregate_promised → ReserveBelowPromised. First call INITS
//       the ledger.
//   - open_standby(cap) — user opens/resizes a standby line backed by a financier;
//       updates aggregate_promised by the delta, enforces the ceiling on increase
//       (StandbyWouldExceedReserve), blocks resize-below-borrowed
//       (ResizeBelowBorrowed), blocks changing backer while one is set
//       (StandbyBackerMismatch).
//   - close_standby(closer: User|Financier) — releases a standby (decrements the
//       financier's aggregate_promised by the vault's cap, clears the vault's
//       terms). Gated borrowed==0 (StandbyStillBorrowed). Callable by EITHER the
//       user (passkey) OR the financier (swig-authority) — the bilateral
//       liveness escape-hatch.
//
// SETUP NOTE (load-bearing): open_standby's `standby_backer` account uses
//   `bump = standby_backer.bump`, so the financier's ledger MUST already exist
//   before any open_standby. set_standby_reserve INITS the ledger (init_if_needed
//   on the first call). So every scenario calls set_standby_reserve at least once
//   BEFORE any open_standby — that both reserves capacity AND creates the ledger.
//
// PROGRAM-AUTHORITY REGISTRATION (mechanism B): the financier-leg SignV2s for
//   set_standby_reserve and close_standby{financier} now route the vault ix as
//   the INNER CPI of the financier swig's SignV2 — the swig_wallet PDA signs it
//   (the rust now requires that signer). The consent is authenticated by a single
//   `Program(dexter_vault)` authority on the FINANCIER's swig (NOT per-instruction
//   ProgramExec markers). enrollCreditVault sets ONE bootstrap marker
//   (role 1 = DRAW_CREDIT, still used by drawCreditAtomic). We register ONE
//   ADDITIONAL Program authority post-enrollment via registerProgramAuthorityOnSwig
//   → role 2, and pass that single `programRole` into BOTH buildSetStandbyReserveTx
//   AND buildCloseStandbyTx (it's a program-scoped permission, not per-discriminator).

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { expect } from "chai";
import { readFileSync } from "fs";
import path from "path";
import {
  makeTestProvider,
  createAtaIdempotentFinalized,
  pollUntilAccount,
} from "./helpers/secp256r1";
import { bootstrapForRegister } from "./helpers/register-bootstrap";
import {
  enrollCreditVault,
  migrateVaultToV5,
  openStandby,
  drawCreditAtomic,
  repayCreditAtomic,
  registerMarkerOnSwig,
  REPAY_CREDIT_DISCRIMINATOR,
} from "./helpers/credit";
import {
  deriveStandbyBackerPda,
  buildSetStandbyReserveTx,
  buildCloseStandbyTx,
  registerProgramAuthorityOnSwig,
} from "./helpers/standby-reserve";

// 6-decimal token units — mirror credit-antirug's $ scaling ($1 == 1_000_000).
const $ = (dollars: number): bigint => BigInt(dollars) * 1_000_000n;

// Fetch + deserialize the financier's StandbyBacker ledger.
async function fetchBacker(
  program: Program<DexterVault>,
  financierSwig: PublicKey,
): Promise<{ aggregate: string; reserve: string; financierSwig: string }> {
  const [backerPda] = deriveStandbyBackerPda(financierSwig);
  const backer = await program.account.standbyBacker.fetch(backerPda);
  return {
    aggregate: (backer as any).aggregatePromised.toString(),
    reserve: (backer as any).committedReserve.toString(),
    financierSwig: (backer as any).financierSwig.toString(),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Shared per-scenario harness. Mirrors credit-antirug.ts: a fresh provider +
// program per describe. We enroll the financier + register ONE Program(vault)
// authority on the financier swig (role 2), and return everything the scenarios
// need. The single `programRole` covers BOTH set_standby_reserve AND
// close_standby{financier} (mechanism B — program-scoped, not per-discriminator).
// ──────────────────────────────────────────────────────────────────────────
interface Harness {
  financier: Awaited<ReturnType<typeof enrollCreditVault>>;
  programRole: number;
}

async function enrollFinancierWithProgramAuthority(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  usdcFundingAmount: bigint,
): Promise<Harness> {
  // FINANCIER vault — role 1 = draw_credit marker (from enroll), V5.
  const financier = await enrollCreditVault(program, provider, {
    usdcFundingAmount,
  });

  // Register the single Program(dexter_vault) authority on the financier swig.
  // First post-enroll add → role 2. This one authority authenticates the
  // financier-leg inner-CPI SignV2 for BOTH set_standby_reserve and
  // close_standby{financier}.
  const programRole = await registerProgramAuthorityOnSwig({
    provider,
    swigAddress: financier.swigAddress,
    vaultProgramId: program.programId,
  });
  expect(programRole).to.equal(2);

  return { financier, programRole };
}

// Enroll a fresh USER vault on the financier's mint (shared-mint so any draw /
// repay SignV2 transfers in ONE token), migrated to V5.
async function enrollUserOnMint(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  mint: PublicKey,
  usdcFundingAmount: bigint,
): Promise<Awaited<ReturnType<typeof bootstrapForRegister>>> {
  const user = await bootstrapForRegister(program, provider, {
    usdcFundingAmount,
    mint,
  });
  await migrateVaultToV5(program, provider, user.vaultPda);
  return user;
}

// ──────────────────────────────────────────────────────────────────────────
// Scenario 1 — reserve ceiling (Σ promises ≤ committed_reserve; R+1 rejected).
//
// setReserve(F, R); openStandby(vaultA, cap=R) succeeds (aggregate==R);
// openStandby(vaultB, cap=1) → StandbyWouldExceedReserve, reverts; assert the
// ledger's aggregate_promised is UNCHANGED (still R) after the failed open.
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S1 — reserve ceiling (Σ ≤ committed_reserve)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("openStandby filling the reserve succeeds; one more unit is rejected (StandbyWouldExceedReserve), aggregate unchanged", async function () {
    this.timeout(600_000);

    const R = $(100); // $100 committed reserve
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );

    // set_standby_reserve(R) — also INITS the ledger.
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: R,
      programRole,
    });
    let backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.reserve).to.equal(R.toString());
    expect(backer.aggregate).to.equal("0");

    // Two user vaults backed by this financier.
    const vaultA = await enrollUserOnMint(program, provider, financier.mint, 0n);
    const vaultB = await enrollUserOnMint(program, provider, financier.mint, 0n);

    // vaultA fills the reserve: cap == R → aggregate == R.
    await openStandby(program, provider, {
      userVaultPda: vaultA.vaultPda,
      userPasskey: vaultA.passkey,
      financierSwig: financier.swigAddress,
      cap: R,
    });
    backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.aggregate).to.equal(R.toString());

    // vaultB tries to promise ONE more unit → would push aggregate to R+1 > R.
    let threw = false;
    try {
      await openStandby(program, provider, {
        userVaultPda: vaultB.vaultPda,
        userPasskey: vaultB.passkey,
        financierSwig: financier.swigAddress,
        cap: 1n,
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/StandbyWouldExceedReserve/);
    }
    expect(
      threw,
      "over-reserve open_standby should reject (StandbyWouldExceedReserve)",
    ).to.equal(true);

    // The failed open moved NOTHING: aggregate still == R (not R+1), and
    // vaultB never got terms.
    backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.aggregate).to.equal(R.toString());
    const vB = await program.account.vault.fetch(vaultB.vaultPda);
    expect((vB as any).standbyBacker).to.equal(null);
    expect((vB as any).standbyCap.toString()).to.equal("0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 4 — reserve lowering.
//
// setReserve(F, R); openStandby(vault, cap=X<R) (aggregate==X); setReserve(F, X)
// succeeds; setReserve(F, X-1) → ReserveBelowPromised.
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S4 — reserve lowering down to (and below) aggregate_promised", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("lowering reserve to aggregate_promised is allowed; one unit below is rejected (ReserveBelowPromised)", async function () {
    this.timeout(600_000);

    const R = $(100);
    const X = $(40); // promised < R
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );

    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: R,
      programRole,
    });

    const vault = await enrollUserOnMint(program, provider, financier.mint, 0n);
    await openStandby(program, provider, {
      userVaultPda: vault.vaultPda,
      userPasskey: vault.passkey,
      financierSwig: financier.swigAddress,
      cap: X,
    });
    let backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.aggregate).to.equal(X.toString());

    // Lower reserve exactly to aggregate_promised (X) — allowed (>=).
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: X,
      programRole,
    });
    backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.reserve).to.equal(X.toString());

    // One unit below aggregate_promised → ReserveBelowPromised.
    let threw = false;
    try {
      await buildSetStandbyReserveTx(program, provider, {
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        newReserve: X - 1n,
        programRole,
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/ReserveBelowPromised/);
    }
    expect(
      threw,
      "lowering reserve below aggregate_promised should reject (ReserveBelowPromised)",
    ).to.equal(true);

    // Reserve unchanged by the failed lowering.
    backer = await fetchBacker(program, financier.swigAddress);
    expect(backer.reserve).to.equal(X.toString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 3 — resize delta tracking + resize-below-borrowed.
//
// openStandby(vault, 100) → aggregate 100; resize to 60 → aggregate 60 (delta
// -40); resize to 90 → aggregate 90 (delta +30); draw to 50; resize to 40 →
// ResizeBelowBorrowed (40 < borrowed 50).
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S3 — resize delta tracking + resize-below-borrowed", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("resize-down then resize-up track aggregate by the delta; a resize below borrowed is rejected (ResizeBelowBorrowed)", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;
    const R = $(200); // reserve covers the max aggregate (100)
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(100), // financier can fund the $50 draw
    );

    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: R,
      programRole,
    });

    const user = await enrollUserOnMint(program, provider, financier.mint, 0n);
    const seller = Keypair.generate();
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      financier.mint,
      seller.publicKey,
    );

    // open cap=100 → aggregate 100.
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: $(100),
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      $(100).toString(),
    );

    // resize-down to 60 → delta -40 → aggregate 60.
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: $(60),
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      $(60).toString(),
    );

    // resize-up to 90 → delta +30 → aggregate 90.
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: $(90),
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      $(90).toString(),
    );

    // Draw to 50 (borrowed = $50, within the $90 cap).
    await drawCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      financierSwigWalletAddrKit: financier.swigWalletAddrKit,
      mint: financier.mint,
      financierSourceAta: financier.sourceAta,
      sellerAta,
      decimals: financier.decimals,
      amount: $(50),
      recoveryWindowSeconds: 300n,
      dexterAuthority: provider.wallet.publicKey,
    });
    const vaultDrawn = await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === $(50).toString(),
    );
    expect((vaultDrawn as any).borrowed.toString()).to.equal($(50).toString());

    // Resize to 40 < borrowed 50 → ResizeBelowBorrowed.
    let threw = false;
    try {
      await openStandby(program, provider, {
        userVaultPda: user.vaultPda,
        userPasskey: user.passkey,
        financierSwig: financier.swigAddress,
        cap: $(40),
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/ResizeBelowBorrowed/);
    }
    expect(
      threw,
      "resize below borrowed should reject (ResizeBelowBorrowed)",
    ).to.equal(true);

    // The failed resize moved nothing: cap still 90, aggregate still 90.
    const vPost = await program.account.vault.fetch(user.vaultPda);
    expect((vPost as any).standbyCap.toString()).to.equal($(90).toString());
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      $(90).toString(),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 5 — block backer-change.
//
// financierA backs vault (cap C); financierB attempts openStandby(same vault) →
// StandbyBackerMismatch; close_standby(by financierA, borrowed==0) →
// financierA.aggregate drops by C, vault terms cleared; financierB
// openStandby(vault) now succeeds → financierB.aggregate rises by C.
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S5 — block backer-change while one is set", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("a different financier cannot overwrite an existing standby; after close, the new financier can attach", async function () {
    this.timeout(600_000);

    const C = $(50);
    const R = $(100);

    const finA = await enrollFinancierWithProgramAuthority(program, provider, $(10));
    const finB = await enrollFinancierWithProgramAuthority(program, provider, $(10));

    // Both financiers reserve capacity (also inits both ledgers).
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: finA.financier.swigAddress,
      financierSwigWalletAddress: finA.financier.swigWalletAddress,
      newReserve: R,
      programRole: finA.programRole,
    });
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: finB.financier.swigAddress,
      financierSwigWalletAddress: finB.financier.swigWalletAddress,
      newReserve: R,
      programRole: finB.programRole,
    });

    // User on financierA's mint (shared mint is fine — no draw here).
    const user = await enrollUserOnMint(
      program,
      provider,
      finA.financier.mint,
      0n,
    );

    // financierA backs the vault.
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: finA.financier.swigAddress,
      cap: C,
    });
    expect(
      (await fetchBacker(program, finA.financier.swigAddress)).aggregate,
    ).to.equal(C.toString());

    // financierB tries to overwrite → StandbyBackerMismatch.
    let threw = false;
    try {
      await openStandby(program, provider, {
        userVaultPda: user.vaultPda,
        userPasskey: user.passkey,
        financierSwig: finB.financier.swigAddress,
        cap: C,
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/StandbyBackerMismatch/);
    }
    expect(
      threw,
      "a different financier overwriting an existing standby should reject (StandbyBackerMismatch)",
    ).to.equal(true);

    // financierA closes (borrowed==0). financierA.aggregate drops by C; terms clear.
    await buildCloseStandbyTx(program, provider, {
      closer: "financier",
      vaultPda: user.vaultPda,
      financierSwig: finA.financier.swigAddress,
      financierSwigWalletAddress: finA.financier.swigWalletAddress,
      programRole: finA.programRole,
    });
    expect(
      (await fetchBacker(program, finA.financier.swigAddress)).aggregate,
    ).to.equal("0");
    const vCleared = await program.account.vault.fetch(user.vaultPda);
    expect((vCleared as any).standbyBacker).to.equal(null);
    expect((vCleared as any).standbyCap.toString()).to.equal("0");

    // financierB can now attach → financierB.aggregate rises by C.
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: finB.financier.swigAddress,
      cap: C,
    });
    expect(
      (await fetchBacker(program, finB.financier.swigAddress)).aggregate,
    ).to.equal(C.toString());
    const vNew = await program.account.vault.fetch(user.vaultPda);
    expect((vNew as any).standbyBacker.toString()).to.equal(
      finB.financier.swigAddress.toString(),
    );
    expect((vNew as any).standbyCap.toString()).to.equal(C.toString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 2 — close lifecycle (financier leg).
//
// setReserve + openStandby(cap C); draw to D>0; close_standby(financier) →
// StandbyStillBorrowed; repay to 0; close_standby(financier) → succeeds,
// financier.aggregate drops by C, vault terms cleared.
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S2 — close lifecycle (financier leg, borrowed gate)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("financier close is blocked while borrowed>0 (StandbyStillBorrowed); after full repay it succeeds and clears terms", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;
    const C = $(50);
    const D = $(30);

    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(100),
    );
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: $(100),
      programRole,
    });

    // USER funded so it can later repay the full $30 from its own swig_wallet ATA.
    const user = await enrollUserOnMint(program, provider, financier.mint, $(30));

    // repay_credit marker on the USER swig (its SignV2 spends the user's wallet).
    // First post-enroll add → role 2.
    const repayRole = await registerMarkerOnSwig({
      provider,
      swigAddress: user.swigAddress,
      vaultProgramId: program.programId,
      discriminator: REPAY_CREDIT_DISCRIMINATOR,
    });
    expect(repayRole).to.equal(2);

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
      financier.mint,
      financierDest.publicKey,
    );

    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: C,
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      C.toString(),
    );

    // Draw to D>0.
    await drawCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      financierSwigWalletAddrKit: financier.swigWalletAddrKit,
      mint: financier.mint,
      financierSourceAta: financier.sourceAta,
      sellerAta,
      decimals: financier.decimals,
      amount: D,
      recoveryWindowSeconds: 300n,
      dexterAuthority: provider.wallet.publicKey,
    });
    await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === D.toString(),
    );

    // close_standby(financier) while borrowed>0 → StandbyStillBorrowed.
    let threw = false;
    try {
      await buildCloseStandbyTx(program, provider, {
        closer: "financier",
        vaultPda: user.vaultPda,
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        programRole,
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/StandbyStillBorrowed/);
    }
    expect(
      threw,
      "financier close with an open loan should reject (StandbyStillBorrowed)",
    ).to.equal(true);
    // The blocked close moved nothing: aggregate still C, terms intact.
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      C.toString(),
    );

    // Repay to 0.
    await repayCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      userSwig: user.swigAddress,
      userSwigWalletAddress: user.swigWalletAddress,
      userSwigWalletAddrKit: user.swigWalletAddrKit,
      mint: user.mint,
      userSourceAta: user.sourceAta,
      financierAta: financierDestAta,
      decimals: user.decimals,
      amount: D, // full repay (== borrowed)
      repayMarkerRole: repayRole,
      dexterAuthority: provider.wallet.publicKey,
    });
    await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === "0",
    );

    // Now close succeeds: aggregate drops by C, terms cleared.
    await buildCloseStandbyTx(program, provider, {
      closer: "financier",
      vaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      programRole,
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      "0",
    );
    const vPost = await program.account.vault.fetch(user.vaultPda);
    expect((vPost as any).standbyBacker).to.equal(null);
    expect((vPost as any).standbyCap.toString()).to.equal("0");
    expect((vPost as any).borrowed.toString()).to.equal("0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 6 — user-callable close (the escape-hatch).
//
// (a) openStandby(cap C), borrowed==0; close_standby(closer=User, user passkey)
//     → succeeds WITHOUT the financier signing; financier.aggregate drops by C,
//     terms cleared.
// (b) openStandby + draw to D>0; close_standby(closer=User) → StandbyStillBorrowed
//     (the user cannot escape a live debt).
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S6 — user-callable close (the bilateral escape-hatch)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("(a) the USER can close their own standby (no financier signature) when borrowed==0", async function () {
    this.timeout(600_000);

    const C = $(50);
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: $(100),
      programRole,
    });

    const user = await enrollUserOnMint(program, provider, financier.mint, 0n);
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: C,
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      C.toString(),
    );

    // USER-leg close: only the user's passkey signs — NO financier SignV2.
    await buildCloseStandbyTx(program, provider, {
      closer: "user",
      vaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      userPasskey: user.passkey,
    });

    // financier.aggregate dropped by C; vault terms cleared.
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      "0",
    );
    const vPost = await program.account.vault.fetch(user.vaultPda);
    expect((vPost as any).standbyBacker).to.equal(null);
    expect((vPost as any).standbyCap.toString()).to.equal("0");
  });

  it("(b) the USER cannot close while borrowed>0 (StandbyStillBorrowed) — no escaping a live debt", async function () {
    this.timeout(600_000);

    const wallet = (provider.wallet as anchor.Wallet).payer;
    const C = $(50);
    const D = $(20);
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(100),
    );
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: $(100),
      programRole,
    });

    const user = await enrollUserOnMint(program, provider, financier.mint, 0n);
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
      cap: C,
    });

    await drawCreditAtomic(program, provider, {
      userVaultPda: user.vaultPda,
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      financierSwigWalletAddrKit: financier.swigWalletAddrKit,
      mint: financier.mint,
      financierSourceAta: financier.sourceAta,
      sellerAta,
      decimals: financier.decimals,
      amount: D,
      recoveryWindowSeconds: 300n,
      dexterAuthority: provider.wallet.publicKey,
    });
    await pollUntilAccount(
      () => program.account.vault.fetch(user.vaultPda),
      (v: any) => v.borrowed.toString() === D.toString(),
    );

    // USER-leg close while borrowed>0 → StandbyStillBorrowed.
    let threw = false;
    try {
      await buildCloseStandbyTx(program, provider, {
        closer: "user",
        vaultPda: user.vaultPda,
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        userPasskey: user.passkey,
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/StandbyStillBorrowed/);
    }
    expect(
      threw,
      "user close with an open loan should reject (StandbyStillBorrowed)",
    ).to.equal(true);

    // Terms intact; aggregate unchanged.
    const vPost = await program.account.vault.fetch(user.vaultPda);
    expect((vPost as any).standbyCap.toString()).to.equal(C.toString());
    expect((vPost as any).borrowed.toString()).to.equal(D.toString());
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      C.toString(),
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 8 — financier consent BINDING (mechanism B; the exploit-closed proof).
//
// THE FIX (commits 5b78778 / 6a52c2a): the rust now types
// financier_swig_wallet_address as `Signer` on set_standby_reserve, and the
// close_standby financier arm requires that signer too. The ONLY way to produce
// that signature is to route the vault ix as the INNER CPI of the financier
// swig's SignV2 (mechanism B), which invoke_signed's the swig_wallet PDA. There
// is no other way to make the PDA sign. So:
//
// (a) THE EXPLOIT, CLOSED: send set_standby_reserve as a BARE vault ix in a plain
//     Transaction — NO SignV2 wrapper, so financier_swig_wallet_address is NOT a
//     signer. The OLD program accepted this (the vacuous-consent bug). The fixed
//     program types that account as `Signer`, so the runtime rejects the tx for a
//     missing required signature BEFORE the handler runs. We assert on the REVERT
//     (a specific custom-error string is NOT expected — this is a runtime
//     signer-verification failure, not a handler-level Anchor error) AND that the
//     StandbyBacker ledger was NEVER created (PDA getAccountInfo === null).
//
// (b) NOT-THE-OWNER: a party who does NOT control the financier swig cannot
//     produce the swig_wallet signer. They have no role on the financier swig
//     carrying a Program(dexter_vault) authority to route a SignV2 through, and
//     the bare-ix path (a) is closed for everyone. We express the tightest
//     unauthorized path: attempt set_standby_reserve via mechanism B routed
//     through a role index that does NOT carry the Program authority (here the
//     draw_credit marker on role 1) — Swig's SignV2 gate refuses to authorize the
//     inner vault CPI under a role lacking the Program(dexter_vault) permission →
//     revert. Assert the revert AND no ledger mutation (PDA still null).
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S8 — financier consent BINDING (mechanism B, exploit-closed)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("(a) set_standby_reserve sent as a BARE ix (no financier SignV2 → swig_wallet not a signer) REVERTS; ledger never created", async function () {
    this.timeout(600_000);

    const { financier } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );
    const [standbyBacker] = deriveStandbyBackerPda(financier.swigAddress);

    // Build the vault ix and send it ALONE in a plain Transaction. The rust types
    // financier_swig_wallet_address as `Signer`, but here it is NOT wrapped in a
    // SignV2, so nothing invoke_signed's the swig_wallet PDA → it is not a signer.
    // NO instructions_sysvar (the fix removed it from set_standby_reserve's
    // accounts). The runtime rejects for a missing required signature.
    //
    // ASSERTION VALIDITY (this is the exploit-closed proof — keep it honest): the
    // accountsPartial below lists EXACTLY the 5 accounts of the fixed struct, all
    // PDAs/keys valid, systemProgram present — so the ONLY missing element is the
    // swig_wallet signature, i.e. the missing-signer path is the only plausible
    // revert. If set_standby_reserve's account struct ever changes, re-verify this
    // ix still reverts for the SIGNER reason and not a new missing/extra-account
    // reason (else 8a would false-green on the wrong revert).
    const setReserveVaultIx = await program.methods
      .setStandbyReserve({ newReserve: new BN($(100).toString()) })
      .accountsPartial({
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        standbyBacker,
        feePayer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();

    let threw = false;
    try {
      await provider.sendAndConfirm(new Transaction().add(setReserveVaultIx));
    } catch (e: any) {
      threw = true;
    }
    expect(
      threw,
      "bare set_standby_reserve (financier swig_wallet not a signer) should REVERT — the exploit is closed",
    ).to.equal(true);

    // The ledger was NEVER created — the missing-signer revert happens before the
    // init/mutation. No StandbyBacker exists at the PDA.
    const info = await provider.connection.getAccountInfo(standbyBacker);
    expect(info, "no StandbyBacker ledger may exist after the rejected bare ix").to.equal(
      null,
    );
  });

  it("(b) set_standby_reserve routed through a role lacking the Program(dexter_vault) authority REVERTS; ledger never created", async function () {
    this.timeout(600_000);

    const { financier } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );

    // Mechanism B routed through role 1 — the draw_credit ProgramExec marker, NOT
    // the Program(dexter_vault) authority (role 2). A party lacking the Program
    // authority on this swig cannot get Swig's SignV2 gate to authorize the inner
    // set_standby_reserve CPI: role 1 carries no Program(dexter_vault) permission
    // for an arbitrary inner vault ix, so invoke_signed of the swig_wallet over it
    // is refused → revert. Stands in for an attacker who does not control the
    // financier swig's Program-authority consent role.
    const WRONG_ROLE = 1; // draw_credit marker — not the Program(vault) authority

    let threw = false;
    try {
      await buildSetStandbyReserveTx(program, provider, {
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        newReserve: $(100),
        programRole: WRONG_ROLE,
      });
    } catch (e: any) {
      threw = true;
    }
    expect(
      threw,
      "set_standby_reserve routed through a role lacking the Program(vault) authority should REVERT",
    ).to.equal(true);

    // ASSERTION VALIDITY (sibling to 8a's note): the coarse `threw` is acceptable
    // here because the WRONG_ROLE route has no non-revert outcome that would still
    // leave the ledger mutated — the getAccountInfo === null check below confirms
    // no StandbyBacker was created on ANY path, so even if the revert arose from a
    // different inner-CPI failure than the Program-authority refusal, the security
    // property (no unauthorized ledger mutation) is still positively verified.
    // No ledger created via the unauthorized path.
    const [standbyBacker] = deriveStandbyBackerPda(financier.swigAddress);
    const info = await provider.connection.getAccountInfo(standbyBacker);
    expect(info, "no StandbyBacker ledger may exist after the unauthorized route").to.equal(
      null,
    );
  });

  it("(c) bare close_standby{financier} (no SignV2 → swig_wallet not a signer) REVERTS with FinancierConsentMissing; standby NOT cleared", async function () {
    this.timeout(600_000);

    // The close financier leg uses the OTHER, higher-risk binding mechanism: not a
    // struct-level `Signer` (8a's set_standby_reserve), but an IN-ARM
    // `require!(financier_swig_wallet_address.is_signer, FinancierConsentMissing)`.
    // The struct types that account as `AccountInfo` (the user leg shares the
    // struct), so a bare ix does NOT fail at sig-verification pre-handler like 8a —
    // it REACHES the handler and the in-arm check fires. This is the close-leg
    // analog of 8a, and the ONLY negative test for the in-arm mechanism.
    //
    // CONTROL FLOW (confirmed against close_standby.rs handler):
    //   1. backer = vault.standby_backer (exists — we open a standby below)
    //   2. Closer::Financier arm: financier_swig.key() == backer → StandbyBackerMismatch
    //      — we pass the REAL backer (we opened with it), so this PASSES.
    //   3. financier_swig_wallet_address.is_signer → FinancierConsentMissing
    //      — bare ix, not wrapped in a SignV2, so the swig_wallet PDA is NOT a
    //        signer → THIS is what reverts.
    //   4. close_standby_core (the decrement + clear) runs ONLY after the arm, so it
    //      never executes → standby is NOT cleared.
    // Because the identity check (step 2) passes with the correct backer, the revert
    // is specifically FinancierConsentMissing (NOT StandbyBackerMismatch). Asserting
    // the specific error is therefore correct here (unlike 8a, where the pre-handler
    // signer-verification failure surfaces no custom error).

    // Setup: a vault with an OPEN standby (borrowed==0) that we then bare-close.
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );

    // (1) Set a reserve via the LEGIT mechanism-B path — inits the ledger + commits
    //     reserve with real financier consent.
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: $(100),
      programRole,
    });

    // (2) User vault opens a standby backed by this financier. cap=$50, borrowed=0.
    const user = await enrollUserOnMint(program, provider, financier.mint, 0n);
    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig: financier.swigAddress,
      cap: $(50),
    });
    // Sanity: terms set + financier promised $50.
    {
      const v = await program.account.vault.fetch(user.vaultPda);
      expect((v as any).standbyBacker.toString()).to.equal(
        financier.swigAddress.toString(),
      );
      expect((v as any).standbyCap.toString()).to.equal($(50).toString());
      expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
        $(50).toString(),
      );
    }

    // (3) THE ATTACK: build close_standby{closer: Financier} as a BARE ix and send
    //     it ALONE — no SignV2 wrapper, so financier_swig_wallet_address is NOT a
    //     signer. We do NOT patch isSigner: that's the whole point. The struct types
    //     the swig_wallet as AccountInfo, so the tx reaches the handler and the
    //     in-arm is_signer check reverts with FinancierConsentMissing.
    const [standbyBacker] = deriveStandbyBackerPda(financier.swigAddress);
    const closeIxBare = await program.methods
      .closeStandby({
        closer: { financier: {} },
        clientDataJson: Buffer.from([]),
        authenticatorData: Buffer.from([]),
      })
      .accountsPartial({
        financierSwig: financier.swigAddress,
        financierSwigWalletAddress: financier.swigWalletAddress,
        vault: user.vaultPda,
        standbyBacker,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY, // close_standby KEEPS this
      })
      .instruction();

    let threw = false;
    let errStr = "";
    try {
      await provider.sendAndConfirm(new Transaction().add(closeIxBare));
    } catch (e: any) {
      threw = true;
      errStr = e.toString();
    }
    expect(
      threw,
      "bare close_standby{financier} (swig_wallet not a signer) should REVERT",
    ).to.equal(true);
    expect(errStr, "should revert with the in-arm consent check").to.match(
      /FinancierConsentMissing/,
    );

    // (4) The close did NOT happen — standby terms intact, aggregate unchanged.
    const userVault = await program.account.vault.fetch(user.vaultPda);
    expect(
      (userVault as any).standbyBacker?.toString(),
      "standby_backer must still be set — close was rejected",
    ).to.equal(financier.swigAddress.toString());
    expect(
      (userVault as any).standbyCap.toString(),
      "standby_cap must be unchanged",
    ).to.equal($(50).toString());
    const backer = await program.account.standbyBacker.fetch(standbyBacker);
    expect(
      (backer as any).aggregatePromised.toString(),
      "aggregate_promised must be unchanged — nothing was released",
    ).to.equal($(50).toString());
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 9 — aggregate enforced at OPEN time (not deferred to draw).
//
// Two vaults, reserve R; openStandby(vaultA, cap=R) → ok; openStandby(vaultB,
// cap>0) → rejected at open_standby with StandbyWouldExceedReserve. The POINT:
// the rejection SITE is open_standby — the ceiling is enforced when the line is
// OPENED, not deferred to a later draw. (Conceptually overlaps S1; this one
// emphasizes the open-time enforcement site.)
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S9 — ceiling enforced at OPEN time (not deferred to draw)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("once the reserve is fully promised, the next open_standby is rejected AT OPEN (StandbyWouldExceedReserve) — never reaching a draw", async function () {
    this.timeout(600_000);

    const R = $(75);
    const { financier, programRole } = await enrollFinancierWithProgramAuthority(
      program,
      provider,
      $(10),
    );
    await buildSetStandbyReserveTx(program, provider, {
      financierSwig: financier.swigAddress,
      financierSwigWalletAddress: financier.swigWalletAddress,
      newReserve: R,
      programRole,
    });

    const vaultA = await enrollUserOnMint(program, provider, financier.mint, 0n);
    const vaultB = await enrollUserOnMint(program, provider, financier.mint, 0n);

    // vaultA fills the reserve exactly.
    await openStandby(program, provider, {
      userVaultPda: vaultA.vaultPda,
      userPasskey: vaultA.passkey,
      financierSwig: financier.swigAddress,
      cap: R,
    });
    expect((await fetchBacker(program, financier.swigAddress)).aggregate).to.equal(
      R.toString(),
    );

    // vaultB's open is rejected AT open_standby — the line never opens, so no
    // draw is ever reachable. Proves open-time enforcement.
    let threw = false;
    try {
      await openStandby(program, provider, {
        userVaultPda: vaultB.vaultPda,
        userPasskey: vaultB.passkey,
        financierSwig: financier.swigAddress,
        cap: $(1),
      });
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/StandbyWouldExceedReserve/);
    }
    expect(
      threw,
      "open_standby beyond the reserve should reject AT OPEN (StandbyWouldExceedReserve)",
    ).to.equal(true);

    // vaultB never opened a line: no terms written → nothing to draw against.
    const vB = await program.account.vault.fetch(vaultB.vaultPda);
    expect((vB as any).standbyBacker).to.equal(null);
    expect((vB as any).standbyCap.toString()).to.equal("0");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Scenario 7 — THE BOUNDARY REGRESSION (structural, NOT a runtime tx).
//
// THE FIREWALL: the financier's Vault is NEVER deserialized as
// Account<'info, Vault> in the credit/reserve instructions. financier_swig is
// identity-only (AccountInfo), never read as a Vault. This is the structural
// guarantee against rehypothecation / leverage-towers: the financier's vault
// state is never touched by these instructions; the swig is pure identity.
//
// VERIFIED by reading the four rust files: the declaration form is
//   `financier_swig: AccountInfo<'info>` in all four
// (open_standby.rs:46, set_standby_reserve.rs:43, close_standby.rs:70,
// draw_credit.rs:57). None deserialize it as Account<'info, Vault>.
// ──────────────────────────────────────────────────────────────────────────
describe("Standby-reserve S7 — FIREWALL boundary regression (structural)", () => {
  it("FIREWALL: financier Vault never deserialized in credit/reserve instructions", () => {
    const files = [
      "programs/dexter-vault/src/instructions/open_standby.rs",
      "programs/dexter-vault/src/instructions/draw_credit.rs",
      "programs/dexter-vault/src/instructions/set_standby_reserve.rs",
      "programs/dexter-vault/src/instructions/close_standby.rs",
    ];
    for (const f of files) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8");
      // Positive: financier_swig IS declared as AccountInfo (identity-only). The
      // exact token in all four files is `financier_swig: AccountInfo<'info>`.
      expect(src, `${f}: financier_swig must be AccountInfo`).to.match(
        /financier_swig:\s*AccountInfo/,
      );
      // Negative (THE firewall): it is NEVER deserialized as a Vault.
      expect(
        src,
        `${f}: financier_swig must NOT be Account<'info, Vault>`,
      ).to.not.match(/financier_swig:\s*Account<'info,\s*Vault>/);
    }
  });
});
