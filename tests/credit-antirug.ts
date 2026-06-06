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
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  makeTestProvider,
  createAtaIdempotentFinalized,
} from "./helpers/secp256r1";
import { bootstrapForRegister } from "./helpers/register-bootstrap";
import {
  enrollCreditVault,
  migrateVaultToV5,
  openStandby,
  drawCreditAtomic,
} from "./helpers/credit";

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
