import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  requestWithdrawalMessage,
  setSwigMessage,
  forceReleaseMessage,
  fundFromProvider,
  P256Keypair,
} from "./helpers/secp256r1";

/**
 * Track 1 upgrade — Findings B + A.
 *
 * B: settle_voucher is now bound to the vault's recorded `dexter_authority`
 *    (has_one). A non-authority signer MUST be rejected — the live-mainnet
 *    exploit must now fail.
 * A: force_release is the stuck-count recovery valve, controlled by the
 *    BUYER's passkey (not Dexter), and gated by a grace period since the
 *    buyer's request_withdrawal. Calls before grace, with no stuck voucher,
 *    or with a wrong/absent passkey signature MUST fail. (The post-grace
 *    success path needs a 7-day clock and is not exercised on localnet; the
 *    rejection paths are what prove the gate holds.)
 */
describe("dexter_authority (Findings B + A)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  // The vault's bound authority for these tests.
  const authority = Keypair.generate();

  async function fund(pubkey: PublicKey) {
    await fundFromProvider(provider, pubkey);
  }

  async function provisionVault(coolingOffSeconds: number) {
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
        coolingOffSeconds,
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

  before(async () => {
    await fund(authority.publicKey);
  });

  // ── Finding B ───────────────────────────────────────────────────────────

  it("initialize_vault records the dexter_authority", async () => {
    const { vaultPda } = await provisionVault(0);
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.dexterAuthority.toBase58()).to.equal(authority.publicKey.toBase58());
  });

  it("settle_voucher SUCCEEDS for the bound authority", async () => {
    const { vaultPda } = await provisionVault(0);
    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true })
      .accounts({ vault: vaultPda, dexterAuthority: authority.publicKey })
      .signers([authority])
      .rpc();
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(1);
  });

  it("settle_voucher REJECTS an unauthorized signer (Finding B closed)", async () => {
    const { vaultPda } = await provisionVault(0);
    const attacker = Keypair.generate();
    await fund(attacker.publicKey);

    let threw = false;
    try {
      await program.methods
        .settleVoucher({ amount: new BN(1_000_000), increment: false })
        .accounts({ vault: vaultPda, dexterAuthority: attacker.publicKey })
        .signers([attacker])
        .rpc();
    } catch (err: any) {
      threw = true;
      // has_one mismatch surfaces as a constraint error.
      expect(String(err)).to.match(/PasskeyVerificationFailed|has_one|ConstraintHasOne|2001/);
    }
    expect(threw, "unauthorized settle_voucher must be rejected").to.equal(true);

    // Counter untouched.
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(0);
  });

  // ── Finding A (force_release — BUYER-controlled) ──────────────────────────

  async function bindSwig(vaultPda: PublicKey, keypair: P256Keypair): Promise<PublicKey> {
    const swigAddress = Keypair.generate().publicKey;
    const opMsg = setSwigMessage(swigAddress);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      keypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .setSwig({
        swigAddress,
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);
    return swigAddress;
  }

  async function setPendingWithdrawal(
    vaultPda: PublicKey,
    keypair: P256Keypair,
    signedAt: bigint
  ) {
    const destination = Keypair.generate().publicKey;
    const amount = BigInt(1_000_000);
    const opMsg = requestWithdrawalMessage(amount, destination, signedAt);
    const signed = signOperationWithPasskey(keypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      keypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .requestWithdrawal({
        amount: new BN(amount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    const tx = new Transaction().add(precompileIx, vaultIx);
    await sendAndConfirmTransaction(provider.connection, tx, [
      (provider.wallet as anchor.Wallet).payer,
    ]);
  }

  // Build a force_release tx signed by `signingKeypair` (the attacker tests
  // sign with a DIFFERENT passkey than the vault's, binding to `swigAddress`).
  async function buildForceReleaseTx(
    vaultPda: PublicKey,
    signingKeypair: P256Keypair,
    swigAddress: PublicKey
  ): Promise<Transaction> {
    const opMsg = forceReleaseMessage(swigAddress);
    const signed = signOperationWithPasskey(signingKeypair, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      signingKeypair.publicKey,
      signed.signature,
      signed.precompileMessage
    );
    const vaultIx = await program.methods
      .forceRelease({
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accounts({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  it("force_release REJECTS when there is no stuck voucher", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const swig = await bindSwig(vaultPda, keypair);

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildForceReleaseTx(vaultPda, keypair, swig),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/NothingToRelease/);
    }
    expect(threw).to.equal(true);
  });

  it("force_release REJECTS before the grace period (buyer signs, but too early)", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const swig = await bindSwig(vaultPda, keypair);
    // Stick the count (authority opens a tab).
    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true })
      .accounts({ vault: vaultPda, dexterAuthority: authority.publicKey })
      .signers([authority])
      .rpc();
    // Buyer requests withdrawal NOW — well within grace.
    const now = BigInt(Math.floor(Date.now() / 1000));
    await setPendingWithdrawal(vaultPda, keypair, now);

    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildForceReleaseTx(vaultPda, keypair, swig),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/ForceReleaseTooEarly/);
    }
    expect(threw, "force_release must be rejected before grace elapses").to.equal(true);

    // Count still stuck (good — the gate held).
    const vault = await program.account.vault.fetch(vaultPda);
    expect(vault.pendingVoucherCount).to.equal(1);
  });

  it("force_release REJECTS a wrong passkey (not the vault's buyer)", async () => {
    const { vaultPda, keypair } = await provisionVault(0);
    const swig = await bindSwig(vaultPda, keypair);
    await program.methods
      .settleVoucher({ amount: new BN(1_000_000), increment: true })
      .accounts({ vault: vaultPda, dexterAuthority: authority.publicKey })
      .signers([authority])
      .rpc();
    const now = BigInt(Math.floor(Date.now() / 1000));
    await setPendingWithdrawal(vaultPda, keypair, now);

    // A different passkey signs — must be rejected by the WebAuthn check.
    const wrongKeypair = generateP256Keypair();
    let threw = false;
    try {
      await sendAndConfirmTransaction(
        provider.connection,
        await buildForceReleaseTx(vaultPda, wrongKeypair, swig),
        [(provider.wallet as anchor.Wallet).payer]
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PasskeyVerificationFailed|ForceReleaseTooEarly/);
    }
    expect(threw, "force_release with a foreign passkey must be rejected").to.equal(true);
  });
});
