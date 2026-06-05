/**
 * Swig + Vault end-to-end settlement test.
 *
 * This is the test that should have existed from day one. Every other
 * withdrawal-flow test in this suite verifies the vault's own state
 * transitions (sets/clears pending_withdrawal) but uses a fake
 * `Keypair.generate().publicKey` as the swig address — so they never
 * exercise the Swig ProgramExec authorization that the production
 * withdrawal path depends on.
 *
 * What this test does:
 *
 *   1. Provisions a real vault (Anchor) with cooling_off = 0.
 *   2. Creates a real Swig wallet whose role 1 is a ProgramExec authority
 *      pointing at THIS vault program with the finalize_withdrawal
 *      discriminator as its instruction prefix. This is the production
 *      shape from dexter-api/src/vault/swigBundle.ts.
 *   3. set_swig binds the vault to the real Swig (passkey-signed).
 *   4. Creates a fresh SPL token mint (throwaway — best practice for
 *      Anchor mainnet tests; the auth model is mint-agnostic).
 *   5. Funds the Swig wallet's ATA with test tokens.
 *   6. request_withdrawal records pending state.
 *   7. finalize_withdrawal + Swig::SignV2(TransferChecked) in ONE tx.
 *      THIS is where the ProgramExec rule is exercised: Swig requires
 *      the preceding vault instruction's first two accounts to be
 *      exactly [swig, swig_wallet_address]. The current vault program
 *      passes [vault, swig, sysvar] — the test will fail with
 *      PermissionDeniedProgramExecInvalidConfigAccount until the
 *      Anchor account struct is reordered.
 *   8. Asserts tokens moved from Swig wallet ATA → destination ATA.
 *
 * Runs against mainnet (the secp256r1 precompile is mainnet-only).
 * Cost per run: ~0.01 SOL (Swig rent + mint rent + tx fees).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import bs58 from "bs58";
import { createHash } from "crypto";

import {
  fetchSwig,
  findSwigPda,
  getCreateSwigInstruction,
  getAddAuthorityInstructions,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
import {
  Actions,
  createEd25519AuthorityInfo,
  createProgramExecAuthorityInfo,
  SolInstruction,
} from "@swig-wallet/lib";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  requestWithdrawalMessage,
  finalizeWithdrawalMessage,
  P256Keypair,
  makeTestProvider,
  pollUntilAccount,
  pollUntilAccountExists,
} from "./helpers/secp256r1";

// The finalize_withdrawal Anchor discriminator. This is the 8-byte
// instruction-data prefix the Swig ProgramExec authority will validate.
// Sourced from dexter-api/src/vault/instructions.ts (and the IDL).
const FINALIZE_WITHDRAWAL_DISCRIMINATOR = new Uint8Array([
  178, 87, 206, 68, 201, 186, 164, 232,
]);

describe("swig settle flow (vault.finalize_withdrawal → Swig::SignV2)", () => {
  const provider = makeTestProvider();
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;

  // The Swig kit talks via @solana/kit's RPC abstraction.
  const rpc = createSolanaRpc(connection.rpcEndpoint);

  it("end-to-end: passkey signs → vault finalize → Swig transfers token", async () => {
    // ──────────────────────────────────────────────────────────────
    // 1. Provision a vault with cooling_off=0 (finalize can run immediately).
    // ──────────────────────────────────────────────────────────────
    const identityClaim = new Uint8Array(32);
    crypto.getRandomValues(identityClaim);
    const passkey = generateP256Keypair();
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(identityClaim.slice(0, 16))],
      program.programId
    );

    await program.methods
      .initializeVault({
        passkeyPubkey: Array.from(passkey.publicKey),
        coolingOffSeconds: 0,
        identityClaim: Array.from(identityClaim),
      })
      .accountsPartial({
        vault: vaultPda,
        payer: wallet.publicKey,
        dexterAuthority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await pollUntilAccountExists(connection, vaultPda);

    // ──────────────────────────────────────────────────────────────
    // 2. Create a real Swig with role 1 = ProgramExec(vault, finalize_withdrawal).
    //    Mirrors dexter-api/src/vault/swigBundle.ts.
    //
    //    The Swig id is HMAC-style derived from identityClaim so the PDA is
    //    deterministic for this run; here we just use a fresh random 32 bytes.
    // ──────────────────────────────────────────────────────────────
    const swigId = new Uint8Array(32);
    crypto.getRandomValues(swigId);
    const swigPdaKit = await findSwigPda(swigId);
    const swigAddress = new PublicKey(String(swigPdaKit));

    // role 0 — bootstrap (our wallet, manageAuthority only)
    const bootstrapAuthority = createEd25519AuthorityInfo(
      Uint8Array.from(wallet.publicKey.toBytes())
    );
    const bootstrapActions = Actions.set().manageAuthority().get();

    // role 1 — the vault, ProgramExec, all() actions
    const vaultProgramIdBytes = Uint8Array.from(program.programId.toBytes());
    const vaultAuthority = createProgramExecAuthorityInfo(
      vaultProgramIdBytes,
      FINALIZE_WITHDRAWAL_DISCRIMINATOR
    );
    const vaultActions = Actions.set().all().get();

    // Create Swig (role 0). getCreateSwigInstruction derives the swig PDA
    // from the id internally — same derivation we did above with findSwigPda.
    const createSwigCtx = await getCreateSwigInstruction({
      payer: kitAddress(wallet.publicKey.toBase58()),
      id: swigId,
      actions: bootstrapActions,
      authorityInfo: bootstrapAuthority,
    });
    const createSwigIxs = kitInstructionsToWeb3([createSwigCtx]);

    const createTx = new Transaction().add(...createSwigIxs);
    await sendAndConfirmTransaction(connection, createTx, [wallet]);
    await pollUntilAccountExists(connection, swigAddress);

    // Add role 1 (ProgramExec — the vault).
    // Cast through `any`: @swig-wallet/coder ships its own nested copy of
    // @solana/* types so the rpc shape from @solana/kit isn't structurally
    // identical to the one swig types want, even though they're the same
    // runtime object. Standard kit/coder duplicated-deps workaround.
    const swigForAdd = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
    if (!swigForAdd) throw new Error("Swig not visible post-create");

    const addAuthorityIxs = await getAddAuthorityInstructions(
      swigForAdd,
      0, // acting role = bootstrap
      vaultAuthority,
      vaultActions,
      { payer: kitAddress(wallet.publicKey.toBase58()) }
    );
    const addTx = new Transaction().add(...kitInstructionsToWeb3(addAuthorityIxs));
    await sendAndConfirmTransaction(connection, addTx, [wallet]);

    // ──────────────────────────────────────────────────────────────
    // 3. set_swig — passkey signs, binding the vault to this real Swig.
    // ──────────────────────────────────────────────────────────────
    const setSwigOp = setSwigMessage(swigAddress);
    const setSwigSigned = signOperationWithPasskey(passkey, setSwigOp);
    const setSwigPrecompile = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      setSwigSigned.signature,
      setSwigSigned.precompileMessage
    );
    const setSwigVaultIx = await program.methods
      .setSwig({
        swigAddress,
        clientDataJson: Buffer.from(setSwigSigned.clientDataJSON),
        authenticatorData: Buffer.from(setSwigSigned.authenticatorData),
      })
      .accountsPartial({
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const setSwigTx = new Transaction().add(setSwigPrecompile, setSwigVaultIx);
    await sendAndConfirmTransaction(connection, setSwigTx, [wallet]);

    // ──────────────────────────────────────────────────────────────
    // 4. Fresh test mint + ATAs.
    // ──────────────────────────────────────────────────────────────
    const mint = await createMint(
      connection,
      wallet,
      wallet.publicKey, // mint authority
      null,
      6 // decimals (mimic USDC)
    );

    const swigForWallet = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
    if (!swigForWallet) throw new Error("Swig not visible for wallet derivation");
    const swigWalletAddrKit = await getSwigWalletAddress(swigForWallet);
    const swigWalletAddress = new PublicKey(String(swigWalletAddrKit));

    // Swig wallet ATA — source of funds.
    const sourceAta = getAssociatedTokenAddressSync(
      mint,
      swigWalletAddress,
      true /* allowOwnerOffCurve — the Swig wallet is a PDA */
    );
    // Create the ATA explicitly (payer = wallet, owner = swig wallet PDA).
    await getOrCreateAssociatedTokenAccount(
      connection,
      wallet,
      mint,
      swigWalletAddress,
      true
    );

    // Mint 10 tokens to the source ATA.
    const FUND_AMOUNT = BigInt(10_000_000); // 10.000000
    await mintTo(connection, wallet, mint, sourceAta, wallet, FUND_AMOUNT);

    // Destination ATA owned by a fresh keypair.
    const destinationOwner = Keypair.generate().publicKey;
    const destAta = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        wallet,
        mint,
        destinationOwner
      )
    ).address;

    // ──────────────────────────────────────────────────────────────
    // 5. request_withdrawal — passkey signs, vault records pending.
    // ──────────────────────────────────────────────────────────────
    const WITHDRAW_AMOUNT = BigInt(3_000_000); // 3.000000
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    const reqOp = requestWithdrawalMessage(WITHDRAW_AMOUNT, destinationOwner, signedAt);
    const reqSigned = signOperationWithPasskey(passkey, reqOp);
    const reqPrecompile = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      reqSigned.signature,
      reqSigned.precompileMessage
    );
    const reqVaultIx = await program.methods
      .requestWithdrawal({
        amount: new BN(WITHDRAW_AMOUNT.toString()),
        destination: destinationOwner,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(reqSigned.clientDataJSON),
        authenticatorData: Buffer.from(reqSigned.authenticatorData),
      })
      .accountsPartial({
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    const reqTx = new Transaction().add(reqPrecompile, reqVaultIx);
    await sendAndConfirmTransaction(connection, reqTx, [wallet]);

    await pollUntilAccount(
      () => program.account.vault.fetch(vaultPda),
      (v: any) => v.pendingWithdrawal !== null
    );

    // ──────────────────────────────────────────────────────────────
    // 6. THE CRITICAL TEST — finalize_withdrawal + Swig::SignV2 in ONE tx.
    //    This exercises Swig's ProgramExec rule:
    //      - preceding ix programId == vault program  ✓
    //      - preceding ix data starts with finalize_withdrawal disc  ✓
    //      - preceding ix accounts[0] == swig            ← REJECTS in current program
    //      - preceding ix accounts[1] == swig_wallet     ← MISSING entirely
    // ──────────────────────────────────────────────────────────────
    const finOp = finalizeWithdrawalMessage(WITHDRAW_AMOUNT, destinationOwner);
    const finSigned = signOperationWithPasskey(passkey, finOp);
    const finPrecompile = buildSecp256r1VerifyInstruction(
      passkey.publicKey,
      finSigned.signature,
      finSigned.precompileMessage
    );
    const finVaultIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(finSigned.clientDataJSON),
        authenticatorData: Buffer.from(finSigned.authenticatorData),
      })
      .accountsPartial({
        vault: vaultPda,
        swig: swigAddress,
        // V0.3 Decision 1: the swig-wallet USDC ATA is read live to enforce
        // the reservation invariant (live_balance_after >=
        // outstanding_locked_amount).
        vaultUsdcAta: sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // The Swig-authorized TransferChecked.
    const transferKitIx = getTransferCheckedInstruction(
      {
        source: kitAddress(sourceAta.toBase58()),
        mint: kitAddress(mint.toBase58()),
        destination: kitAddress(destAta.toBase58()),
        authority: swigWalletAddrKit,
        amount: WITHDRAW_AMOUNT,
        decimals: 6,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS }
    );
    const swigForSign = await fetchSwig(rpc as any, kitAddress(swigAddress.toBase58()));
    if (!swigForSign) throw new Error("Swig not visible for sign");
    const signKitIxs = await getSignInstructions(
      swigForSign,
      1, // role 1 = vault ProgramExec
      [transferKitIx],
      false,
      {
        payer: kitAddress(wallet.publicKey.toBase58()),
        // SolInstruction.from accepts a web3.js TransactionInstruction.
        preInstructions: [finVaultIx as any],
      }
    );
    const signWeb3Ixs = kitInstructionsToWeb3(signKitIxs);

    // Kit's getSignInstructions returns BOTH the preInstructions and the SignV2
    // in one ordered array — we don't manually re-add finVaultIx.
    const finalTx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      finPrecompile,
      ...signWeb3Ixs
    );

    // The big moment. This will throw with
    //   PermissionDeniedProgramExecInvalidConfigAccount
    // until the Anchor account struct in finalize_withdrawal.rs is reordered.
    await sendAndConfirmTransaction(connection, finalTx, [wallet]);

    // ──────────────────────────────────────────────────────────────
    // 7. Assert the token actually moved.
    // ──────────────────────────────────────────────────────────────
    const sourceAfter = await getAccount(connection, sourceAta);
    const destAfter = await getAccount(connection, destAta);

    expect(sourceAfter.amount.toString()).to.equal(
      (FUND_AMOUNT - WITHDRAW_AMOUNT).toString(),
      "source ATA should be debited"
    );
    expect(destAfter.amount.toString()).to.equal(
      WITHDRAW_AMOUNT.toString(),
      "destination ATA should be credited"
    );

    // Vault should have cleared pending_withdrawal.
    const vaultFinal: any = await program.account.vault.fetch(vaultPda);
    expect(vaultFinal.pendingWithdrawal).to.equal(null);
  });
});

// =========================================================================
// Kit v2 → Web3.js v1 converter (mirrors dexter-api/src/swig/transactionSerializer.ts).
// =========================================================================

function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
    // Use SolInstruction.from as the canonical bridge.
    const sol = SolInstruction.from(ix);
    const web3 = sol.toWeb3Instruction();
    return {
      programId: new PublicKey(web3.programId.toBase58()),
      keys: web3.keys.map((k: any) => ({
        pubkey: new PublicKey(k.pubkey.toBase58()),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(web3.data),
    } as TransactionInstruction;
  });
}
