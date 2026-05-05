import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("initialize_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("creates a vault PDA with passkey pubkey + cooling-off + supabase user id", async () => {
    const supabaseUserId = new Uint8Array(16);
    crypto.getRandomValues(supabaseUserId);
    const passkeyPubkey = new Uint8Array(33);
    crypto.getRandomValues(passkeyPubkey);
    passkeyPubkey[0] = 0x02;

    const [vaultPda, bump] = PublicKey.findProgramAddressSync(
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
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.bump).to.equal(bump);
    expect(Buffer.from(vault.passkeyPubkey)).to.deep.equal(Buffer.from(passkeyPubkey));
    expect(vault.coolingOffSeconds.toNumber()).to.equal(86400);
    expect(vault.pendingVoucherCount).to.equal(0);
    expect(vault.pendingWithdrawal).to.be.null;
  });
});
