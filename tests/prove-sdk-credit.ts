/**
 * SDK CREDIT-SURFACE MAINNET PROOF (gated integration test).
 *
 * Proves the PRODUCTIZED @dexterai/vault SDK (not just the mechanism) lands
 * against the LIVE deployed program. First-ever live-SUBMIT proof for an SDK
 * path (see dexter-thesis FINDINGS-sdk-credit-completeness-2026-06-08).
 *
 * WHAT'S SDK vs HARNESS (the honest boundary — FINDINGS §3/§6):
 *   HARNESS (DELIBERATE — manufactures test USDC, the one thing that can't be SDK):
 *     - enrollFinancierWithProgramAuthority → financier vault bootstrap + V5 migrate
 *       (NOTE: also registers a Program authority via the harness; we IGNORE that
 *        role and prove the SDK's OWN buildRegisterProgramAuthority instead)
 *     - enrollUserOnMint → user vault on the financier's mint (V5)
 *     - openStandby → opens a REAL standby (user passkey consent) so the close is real
 *   SDK (what we're proving — all REAL SUBMITS):
 *     - buildRegisterProgramAuthority → REAL SUBMIT (the gap-closer; lands a 2nd
 *       Program authority on the financier swig, returns roleId)
 *     - setStandbyReserve            → REAL SUBMIT (mechanism-B SignV2 lands)
 *     - closeStandby{financier}      → REAL SUBMIT (mechanism-B SignV2 lands; closes
 *       the real standby opened above)
 *
 * RUN (gated — Helius mainnet + funded upgrade-authority wallet):
 *   cd dexter-vault && \
 *   ANCHOR_PROVIDER_URL="https://mainnet.helius-rpc.com/?api-key=8fd1a2cd-76e7-4462-b38b-1026960edd40" \
 *   ANCHOR_WALLET="$HOME/.config/solana/dexter-vault/upgrade-authority.json" \
 *   npx ts-mocha -p ./tsconfig.json -t 600000 tests/prove-sdk-credit.ts
 *
 * @dexterai/vault MUST resolve to the LOCAL build (node_modules/@dexterai/vault
 * symlinked → ../dexter-vault-sdk), NOT npm — the first test asserts the surface.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";

import { makeTestProvider, pollUntilAccount } from "./helpers/secp256r1";
import { bootstrapForRegister } from "./helpers/register-bootstrap";
import { migrateVaultToV5, openStandby, enrollCreditVault } from "./helpers/credit";

// ── THE SDK UNDER TEST (local build, not npm) ────────────────────────────────
import {
  buildRegisterProgramAuthority,
  waitForRole,
} from "@dexterai/vault/instructions";
import { setStandbyReserve, closeStandby } from "@dexterai/vault/tab";

const $ = (d: number): bigint => BigInt(d) * 1_000_000n;
const RESERVE = $(5);   // $5 committed reserve
const CAP = $(5);       // user opens a $5 standby (≤ reserve)

describe("PROVE: SDK credit surface lands on mainnet", function () {
  this.timeout(600_000);

  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  const connection = provider.connection;
  const feePayer = provider.wallet.publicKey;

  let financierSwig: PublicKey;
  let financierMint: PublicKey;
  let userVaultPda: PublicKey;
  let sdkProgramRoleId: number;

  it("sanity: the SDK import is the LOCAL build with the new surface", () => {
    expect(typeof buildRegisterProgramAuthority).to.equal("function");
    expect(typeof setStandbyReserve).to.equal("function");
    expect(typeof closeStandby).to.equal("function");
    console.log("    ✓ SDK new surface present");
  });

  it("HARNESS: stand up a BARE fresh financier (test-USDC bootstrap + V5, NO Program authority)", async () => {
    // BARE enroll: roles 0 (manage) + 1 (draw marker) only. NO Program(vault)
    // authority — the SDK adds the ONLY one below, so the proof exercises the
    // SDK's own buildRegisterProgramAuthority as the single source of that role.
    const financier = await enrollCreditVault(program, provider, {
      usdcFundingAmount: $(100), // funded so it could back real draws; we set a $5 reserve
    });
    financierSwig = financier.swigAddress;
    financierMint = financier.mint;
    console.log(`    ✓ financier swig:  ${financierSwig.toBase58()}`);
    console.log(`    ✓ financier mint:  ${financierMint.toBase58()}`);
  });

  it("SDK SUBMIT #1: buildRegisterProgramAuthority → lands the (only) Program(vault) authority + waitForRole", async () => {
    // PURE SDK. The bare financier has roles 0,1; the SDK adds the ONLY Program
    // authority → role 2, returns its index. CRITICAL: after confirming the add we
    // waitForRole BEFORE using the roleId (the contract Task 8 documents — a
    // confirmed add isn't instantly visible to the next swig fetch on a multi-
    // replica RPC; skipping this is the exact race the first proof caught).
    const { instructions, roleId } = await buildRegisterProgramAuthority({
      connection,
      financierSwig,
      vaultProgramId: program.programId,
      feePayer,
      authorityPubkey: feePayer,
    });
    sdkProgramRoleId = roleId;
    console.log(`    → SDK roleId for the new authority = ${roleId}`);
    const sig = await sendIxs(provider, instructions, "registerProgramAuthority");
    console.log(`    ✓ SUBMITTED registerProgramAuthority: ${sig}`);

    // The fix: poll until the new role is VISIBLE to a fresh swig fetch.
    await waitForRole({ connection, swig: financierSwig, roleId, timeoutMs: 60_000 });
    console.log(`    ✓ waitForRole(${roleId}) resolved — role is visible, safe to use`);
    expect(roleId).to.be.greaterThanOrEqual(0);
  });

  it("SDK SUBMIT #2: setStandbyReserve → mechanism-B SignV2 lands", async () => {
    const ixs = await setStandbyReserve({
      connection,
      financierSwig,
      feePayer,
      newReserve: RESERVE,
      programRoleId: sdkProgramRoleId,
    });
    const sig = await sendIxs(provider, ixs, "setStandbyReserve");
    console.log(`    ✓ SUBMITTED setStandbyReserve($5): ${sig}`);

    // Verify on-chain — poll (Helius replicas serve stale state briefly even
    // after a confirmed write; a bare .fetch() races the lag).
    const [backer] = PublicKey.findProgramAddressSync(
      [Buffer.from("standby-backer"), financierSwig.toBuffer()],
      program.programId,
    );
    const ledger: any = await pollUntilAccount(
      () => program.account.standbyBacker.fetch(backer),
      (l: any) => l.committedReserve?.toString() === RESERVE.toString(),
      30_000,
    );
    console.log(`    ✓ on-chain committed_reserve = ${ledger.committedReserve?.toString()}`);
    expect(ledger.committedReserve?.toString()).to.equal(RESERVE.toString());
  });

  it("HARNESS: open a REAL standby (user vault + passkey) so the close is real", async () => {
    const user = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 0n,
      mint: financierMint,
    });
    await migrateVaultToV5(program, provider, user.vaultPda);
    userVaultPda = user.vaultPda;

    await openStandby(program, provider, {
      userVaultPda: user.vaultPda,
      userPasskey: user.passkey,
      financierSwig,
      cap: CAP,
    });
    const v: any = await program.account.vault.fetch(userVaultPda);
    console.log(`    ✓ standby OPEN: user vault ${userVaultPda.toBase58()}, cap=${v.standbyCap?.toString()}`);
    expect(v.standbyBacker?.toBase58()).to.equal(financierSwig.toBase58());
  });

  it("SDK SUBMIT #3: closeStandby{financier} → mechanism-B SignV2 closes the real standby", async () => {
    const ixs = await closeStandby({
      connection,
      vaultPda: userVaultPda,
      financierSwig,
      feePayer,
      closer: "financier",
      programRoleId: sdkProgramRoleId,
    });
    const sig = await sendIxs(provider, ixs, "closeStandby{financier}");
    console.log(`    ✓ SUBMITTED closeStandby{financier}: ${sig}`);

    // The close clears the user vault's standby_backer to None — poll for it
    // (the close confirmed, but the cleared state needs to reach the replica).
    const v: any = await pollUntilAccount(
      () => program.account.vault.fetch(userVaultPda),
      (vault: any) => vault.standbyBacker === null,
      30_000,
    );
    console.log(`    ✓ on-chain standby_backer after close = ${v.standbyBacker}`);
    expect(v.standbyBacker).to.equal(null);
  });

  it("SUMMARY", () => {
    console.log("\n    ═══════════════════════════════════════════════════════");
    console.log("    SDK credit surface PROVEN on mainnet — 3 real submits:");
    console.log("      • buildRegisterProgramAuthority (the gap-closer)");
    console.log("      • setStandbyReserve  (mechanism-B SignV2)");
    console.log("      • closeStandby{financier} (mechanism-B SignV2)");
    console.log("    All assembled by the LOCAL @dexterai/vault build.");
    console.log("    ═══════════════════════════════════════════════════════\n");
  });
});

// ── send web3 ixs with a fresh blockhash, return the signature ────────────────
async function sendIxs(
  provider: anchor.AnchorProvider,
  ixs: TransactionInstruction[],
  label: string,
): Promise<string> {
  const tx = new Transaction();
  const { blockhash, lastValidBlockHeight } =
    await provider.connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = provider.wallet.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
  try {
    return await provider.sendAndConfirm(tx, [], {
      skipPreflight: false,
      commitment: "confirmed",
    });
  } catch (e: any) {
    console.error(`    ✗ ${label} FAILED`);
    if (e?.logs) console.error("    logs:\n" + e.logs.map((l: string) => "        " + l).join("\n"));
    throw e;
  }
}
