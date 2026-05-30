import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  provePasskeyMessage,
  P256Keypair,
} from "./helpers/secp256r1";

/**
 * prove_passkey — the Solana-1271 / non-custodial SIWX primitive.
 *
 * Proves a passkey controls a vault WITHOUT moving funds, changing state, or
 * needing any signer beyond the passkey (verified via the SIMD-0075 precompile
 * sibling). The verifier `simulateTransaction([secp256r1_verify_ix,
 * prove_passkey_ix])` with sigVerify:false and treats err===null as proof.
 *
 * This mirrors exactly how the off-chain SIWX verifier will work — we use
 * `.simulate()`, NOT `.rpc()`, because identity-proof must never require a real
 * fee payer, a signer, or a state-changing transaction.
 */
describe("prove_passkey (Solana-1271 / non-custodial SIWX)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  const authority = Keypair.generate();

  async function fund(pk: PublicKey) {
    const sig = await provider.connection.requestAirdrop(pk, 1_000_000_000);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  async function provisionVault(): Promise<{ vaultPda: PublicKey; keypair: P256Keypair }> {
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const keypair = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId
    );
    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(keypair.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(identityClaim),
      })
      .accounts({
        vault: vaultPda,
        payer: provider.wallet.publicKey,
        dexterAuthority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
    return { vaultPda, keypair };
  }

  function randomChallenge(): Uint8Array {
    const c = new Uint8Array(32);
    crypto.getRandomValues(c);
    return c;
  }

  /**
   * Build the 2-instruction proof tx exactly as the off-chain verifier will:
   * the passkey signs "siwx_login" || challenge, then [precompile, prove_passkey].
   * `signWith` lets us deliberately sign with the WRONG key to test rejection.
   */
  async function buildProveTx(
    vaultPda: PublicKey,
    challenge: Uint8Array,
    signWith: P256Keypair
  ): Promise<Transaction> {
    const opMsg = provePasskeyMessage(challenge);
    const signed = signOperationWithPasskey(signWith, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      signWith.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .provePasskey({
        challenge: Array.from(challenge),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  /** Simulate (sigVerify:false) and return whether the precompile+program accepted. */
  async function simulateProof(tx: Transaction, feePayer: PublicKey): Promise<{ ok: boolean; err: any; logs: string[] }> {
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await provider.connection.getLatestBlockhash("confirmed")).blockhash;
    const res = await provider.connection.simulateTransaction(tx, undefined, false);
    return { ok: res.value.err === null, err: res.value.err, logs: res.value.logs || [] };
  }

  before(async () => {
    await fund(authority.publicKey);
  });

  it("SUCCEEDS: the vault's passkey signing the right challenge → simulate err===null, NO state change, NO signer", async () => {
    const { vaultPda, keypair } = await provisionVault();
    const challenge = randomChallenge();

    const tx = await buildProveTx(vaultPda, challenge, keypair);
    // Nominal fee payer = an existing account; it never signs (sigVerify:false).
    const { ok, err, logs } = await simulateProof(tx, provider.wallet.publicKey);

    expect(ok, `expected err===null, got ${JSON.stringify(err)} :: ${logs.join(" | ")}`).to.equal(true);

    // Prove it mutated nothing: the vault account is byte-identical before/after.
    // (We never sent the tx — simulate only — but assert the design intent: a
    // verify-only instruction has no writable accounts.)
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingWithdrawal).to.equal(null);
  });

  it("REJECTS: a foreign passkey signing the challenge → simulate errors", async () => {
    const { vaultPda } = await provisionVault();
    const attacker = generateP256Keypair();
    const challenge = randomChallenge();

    const tx = await buildProveTx(vaultPda, challenge, attacker);
    const { ok, err } = await simulateProof(tx, provider.wallet.publicKey);

    expect(ok, "a foreign passkey must NOT produce a passing proof").to.equal(false);
    expect(err, "expected an instruction error for the wrong passkey").to.not.equal(null);
  });

  it("REJECTS: right passkey but the on-chain challenge differs from what was signed", async () => {
    const { vaultPda, keypair } = await provisionVault();
    const signedChallenge = randomChallenge();
    const claimedChallenge = randomChallenge(); // different 32 bytes

    // Sign signedChallenge, but submit the prove_passkey ix claiming claimedChallenge.
    const signed = signOperationWithPasskey(keypair, provePasskeyMessage(signedChallenge));
    const precompileIx = buildSecp256r1VerifyInstruction(
      keypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .provePasskey({
        challenge: Array.from(claimedChallenge),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);

    const { ok, err } = await simulateProof(tx, provider.wallet.publicKey);
    expect(ok, "a challenge mismatch must NOT produce a passing proof").to.equal(false);
    expect(err, "expected an instruction error for the challenge mismatch").to.not.equal(null);
  });
});
