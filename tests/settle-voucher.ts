import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";

/**
 * settle_voucher gate-counter round-trip — V6.
 *
 * V6 moved settle_voucher onto a V6 vault + per-counterparty SessionAccount
 * PDA: the `increment == true` (tab-open) path now requires a live session PDA
 * (it raises `current_outstanding`, capped by `max_revolving_capacity`) and the
 * args carry `allowed_counterparty` so the accounts struct re-derives the PDA.
 * The `increment == false` (close) path is a bare `pending_voucher_count`
 * decrement that touches no session — but it still requires a V6 vault.
 *
 * So every vault here is provisioned via the V6 apparatus
 * (bootstrapForRegister{migrateTo:6} + registerSessionV2) and the increment
 * calls thread `session: sessionPda` + `allowedCounterparty: seller`. The
 * decrement calls thread the same `allowedCounterparty` (load-bearing only on
 * the increment path; ignored on close) but need no session account.
 *
 * dexterAuthority on every settle is the provider wallet — bootstrapForRegister
 * inits the vault with `dexter_authority = provider.wallet`, so the has_one on
 * settle_voucher is satisfied by the provider signer (Anchor signs by default).
 */
describe("settle_voucher", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  // Provision a V6 vault with one registered session bound to a fresh seller.
  // The session's allowed_counterparty IS the seller, so [SESSION_SEED, vault,
  // seller] is exactly the PDA the increment path re-derives.
  async function provisionV6() {
    const vault = await bootstrapForRegister(program, provider, {
      // Fund headroom so the register overcommit gate passes (maxAmount +
      // maxRevolvingCapacity ≤ live ATA balance).
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const seller = Keypair.generate().publicKey;
    const { sessionPda } = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      allowedCounterparty: seller,
    });
    return { vaultPda: vault.vaultPda, seller, sessionPda };
  }

  it("increments pending_voucher_count when voucher is registered", async () => {
    const { vaultPda, seller, sessionPda } = await provisionV6();

    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true, allowedCounterparty: seller })
      .accountsPartial({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: sessionPda,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(1);
  });

  it("decrements pending_voucher_count when voucher is settled (round trip)", async () => {
    const { vaultPda, seller, sessionPda } = await provisionV6();

    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true, allowedCounterparty: seller })
      .accountsPartial({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: sessionPda,
      })
      .rpc();

    // Close path: bare counter decrement, no session touched. allowedCounterparty
    // is ignored here, but supplied for arg-shape parity.
    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: false, allowedCounterparty: seller })
      .accountsPartial({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(0);
  });

  it("rejects decrement when count is already zero", async () => {
    const { vaultPda, seller } = await provisionV6();

    let threw = false;
    try {
      await program.methods
        .settleVoucher({ amount: new BN(1_000_000), increment: false, allowedCounterparty: seller })
        .accountsPartial({
          vault: vaultPda,
          dexterAuthority: provider.wallet.publicKey,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/NoPendingWithdrawal/);
    }
    expect(threw).to.equal(true);
  });
});
