import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("initialize_vault (v2)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("creates a v2 vault PDA with version=2, passkey, cooling-off, identity_claim", async () => {
    // Identity claim is 32 bytes now; we use the first 16 as the PDA seed
    // (matches the new initialize_vault seed of `&args.identity_claim[..16]`).
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const passkeyPubkey = new Uint8Array(33);
    crypto.getRandomValues(passkeyPubkey);
    passkeyPubkey[0] = 0x02;

    const [vaultPda, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId
    );

    const dexterAuthority = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(dexterAuthority.publicKey, 1_000_000);
    await provider.connection.confirmTransaction(sig, "confirmed");

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkeyPubkey),
        coolingOffSeconds: 86_400,
        identityClaim: Array.from(identityClaim),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        dexterAuthority: dexterAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([dexterAuthority])
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.version).to.equal(2);
    expect(vault.bump).to.equal(bump);
    expect(Buffer.from(vault.passkeyPubkey)).to.deep.equal(Buffer.from(passkeyPubkey));
    expect(vault.coolingOffSeconds).to.equal(86_400);
    expect(vault.pendingVoucherCount).to.equal(0);
    expect(vault.pendingWithdrawal).to.be.null;
    expect(Buffer.from(vault.identityClaim)).to.deep.equal(Buffer.from(identityClaim));
    expect(vault.dexterAuthority.toBase58()).to.equal(dexterAuthority.publicKey.toBase58());
    expect(vault.activeSession).to.be.null;
  });
});
