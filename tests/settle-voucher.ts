import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("settle_voucher", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  async function provisionVault() {
    const supabaseUserId = new Uint8Array(16);
    crypto.getRandomValues(supabaseUserId);
    const passkeyPubkey = new Uint8Array(33);
    crypto.getRandomValues(passkeyPubkey);
    passkeyPubkey[0] = 0x02;
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(supabaseUserId)],
      program.programId
    );
    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkeyPubkey),
        coolingOffSeconds: new BN(86400),
        supabaseUserId: Array.from(supabaseUserId),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        // The provider wallet is the bound authority for these tests, so it
        // can sign settle_voucher below.
        dexterAuthority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return vaultPda;
  }

  it("increments pending_voucher_count when voucher is registered", async () => {
    const vaultPda = await provisionVault();

    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true })
      .accounts({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(1);
  });

  it("decrements pending_voucher_count when voucher is settled (round trip)", async () => {
    const vaultPda = await provisionVault();

    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true })
      .accounts({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: false })
      .accounts({
        vault: vaultPda,
        dexterAuthority: provider.wallet.publicKey,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(0);
  });

  it("rejects decrement when count is already zero", async () => {
    const vaultPda = await provisionVault();

    let threw = false;
    try {
      await program.methods
        .settleVoucher({ amount: new BN(1_000_000), increment: false })
        .accounts({
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
