import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";

describe("initialize_vault (V6 at birth)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("creates a vault PDA stamped version=6 with passkey, cooling-off, identity_claim, and every V4/V5/V6 field neutral", async () => {
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

    // dexter_authority is a Signer<'info> but not writable + not the payer,
    // so the keypair just needs to sign — it doesn't need any lamports.
    const dexterAuthority = Keypair.generate();

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkeyPubkey),
        coolingOffSeconds: 86_400,
        identityClaim: Array.from(identityClaim),
      })
      .accountsPartial({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        dexterAuthority: dexterAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([dexterAuthority])
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    // BORN-V6: the account is the V6 layout, so byte 0 must say 6. (The
    // 1.x-era handler wrote the V6 shape but stamped V4 — the "born-broken"
    // cohort this assertion guards against regressing.)
    expect(vault.version).to.equal(6);
    expect(vault.bump).to.equal(bump);
    expect(Buffer.from(vault.passkeyPubkey)).to.deep.equal(Buffer.from(passkeyPubkey));
    expect(vault.coolingOffSeconds).to.equal(86_400);
    expect(vault.pendingVoucherCount).to.equal(0);
    expect(vault.pendingWithdrawal).to.be.null;
    expect(Buffer.from(vault.identityClaim)).to.deep.equal(Buffer.from(identityClaim));
    expect(vault.dexterAuthority.toBase58()).to.equal(dexterAuthority.publicKey.toBase58());
    // V6: a fresh vault has no session PDAs.
    expect(vault.liveSessionCount).to.equal(0);
    // V4 LockedClaim odometers: all zero at birth.
    expect(vault.outstandingLockedAmount.toString()).to.equal("0");
    expect(vault.totalCrystallizedAmount.toString()).to.equal("0");
    expect(vault.totalSettledAmount.toString()).to.equal("0");
    // V5 credit fields: neutral at birth — no financier, nothing borrowed.
    expect(vault.borrowed.toString()).to.equal("0");
    expect(vault.standbyBacker).to.be.null;
    expect(vault.standbyCap.toString()).to.equal("0");
    expect(vault.borrowRecoveryAt).to.be.null;
  });
});
