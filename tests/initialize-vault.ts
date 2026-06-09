import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { makeTestProvider } from "./helpers/secp256r1";

describe("initialize_vault (v2)", () => {
  const provider = makeTestProvider();
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
    expect(vault.version).to.equal(2);
    expect(vault.bump).to.equal(bump);
    expect(Buffer.from(vault.passkeyPubkey)).to.deep.equal(Buffer.from(passkeyPubkey));
    expect(vault.coolingOffSeconds).to.equal(86_400);
    expect(vault.pendingVoucherCount).to.equal(0);
    expect(vault.pendingWithdrawal).to.be.null;
    expect(Buffer.from(vault.identityClaim)).to.deep.equal(Buffer.from(identityClaim));
    expect(vault.dexterAuthority.toBase58()).to.equal(dexterAuthority.publicKey.toBase58());
    // V6 MIGRATION NOTE: the V6 Vault struct REMOVED `active_session` (sessions
    // moved to per-counterparty SessionAccount PDAs). initialize_vault still
    // writes a V4 vault, so there is no V6 `live_session_count` on this account
    // to read either — the "fresh vault has no session" intent is already
    // covered by `pendingVoucherCount == 0` above. The removed-field assertion
    // is dropped rather than faked.
  });
});
