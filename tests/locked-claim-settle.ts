// settle_locked_voucher integration tests (mainnet, build-only).
//
// Three scenarios cover Task 5 of the Phase 1 LockedClaim plan:
//   1. Happy path — lock $1, settle (vault::settle_locked_voucher +
//      swig::SignV2(TransferChecked) in the same tx). Claim moves
//      Pending → Settled, settled_at set, recovered_at stays null,
//      vault.outstanding_locked_amount decrements, vault.total_settled_amount
//      increments, holder USDC balance rises by $1.
//   2. Wrong holder rejection — an imposter (not current_holder) attempts
//      to drive the settle; the constraint
//      `claim.current_holder == holder.key()` rejects.
//   3. Double-settle rejection — settle the same claim twice; the second
//      attempt hits the `claim.status == Pending` constraint because
//      status is now Settled (state machine is terminal one-way per
//      V0.3 Decision 6).
//
// IMPORTANT: pre-deploy, these tests fail with
// `InstructionFallbackNotFound (custom 0x65)` because the
// settle_locked_voucher discriminator is not yet on chain. Post-deploy
// verification lands in Task 9 (collective verification).
//
// Swig marker discipline: lock_voucher.ts's enrollLockableVault registers
// only role 1 ProgramExec(vault, SETTLE_TAB_VOUCHER_DISCRIMINATOR). For
// Task 5, the swig CPI in [N+1] needs a marker for
// settle_locked_voucher's discriminator. We add role 2 ProgramExec(vault,
// SETTLE_LOCKED_VOUCHER_DISCRIMINATOR) manually post-enrollment — this is
// what the brief calls "Phase 1 tests register the new marker manually
// on fresh enrollment". SDK marker-list update is Phase 2 work.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { expect } from "chai";
import {
  makeTestProvider,
  createAtaIdempotentFinalized,
  pollUntilAccount,
} from "./helpers/secp256r1";
import { setupLockedClaim } from "./helpers/locked-claim";
import {
  fetchSwig,
  getAddAuthorityInstructions,
  getSignInstructions,
} from "@swig-wallet/kit";
import {
  Actions,
  createProgramExecAuthorityInfo,
  SolInstruction,
} from "@swig-wallet/lib";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// Anchor instruction discriminator for `settle_locked_voucher`:
// sha256("global:settle_locked_voucher")[..8]. Verified against
// target/idl/dexter_vault.json post-build.
const SETTLE_LOCKED_VOUCHER_DISCRIMINATOR = new Uint8Array([
  44, 80, 216, 43, 247, 253, 101, 45,
]);

// Kit v2 → web3.js v1 instruction converter (same shape as
// lock-voucher.ts; kit's nested @solana/* type duplication forces this).
function kitInstructionsToWeb3(kitInstructions: any[]): TransactionInstruction[] {
  return kitInstructions.map((ix) => {
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

// Register a NEW Swig authority (role 2) with ProgramExec authority bound
// to the vault program and the settle_locked_voucher discriminator. The
// bootstrap key (role 0) has manageAuthority and signs the add. This is
// the marker that lets the [N+1] swig::SignV2 in settle_locked_voucher's
// atomic flow validate against the on-chain marker list.
async function registerSettleLockedVoucherMarker(args: {
  provider: anchor.AnchorProvider;
  swigAddress: PublicKey;
  vaultProgramId: PublicKey;
}): Promise<void> {
  const { provider, swigAddress, vaultProgramId } = args;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const swigForAdd = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58())
  );
  if (!swigForAdd) throw new Error("Swig not visible for marker add");

  const vaultProgramIdBytes = Uint8Array.from(vaultProgramId.toBytes());
  const settleLockedAuthority = createProgramExecAuthorityInfo(
    vaultProgramIdBytes,
    SETTLE_LOCKED_VOUCHER_DISCRIMINATOR
  );
  const fullActions = Actions.set().all().get();

  const addAuthorityIxs = await getAddAuthorityInstructions(
    swigForAdd,
    0,
    settleLockedAuthority,
    fullActions,
    { payer: kitAddress(wallet.publicKey.toBase58()) }
  );
  await provider.sendAndConfirm(
    new Transaction().add(...kitInstructionsToWeb3(addAuthorityIxs))
  );
}

// Atomic settle: [N] vault::settle_locked_voucher + [N+1]
// swig::SignV2(TransferChecked). Mirrors revolving-meter / lock-voucher's
// settleTabAtomic shape but routes through role 2 (settle_locked_voucher
// marker) instead of role 1 (settle_tab_voucher marker).
async function settleLockedAtomic(args: {
  program: Program<DexterVault>;
  provider: anchor.AnchorProvider;
  vaultPda: PublicKey;
  claimPda: PublicKey;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  swigWalletAddrKit: ReturnType<typeof kitAddress>;
  mint: PublicKey;
  sourceAta: PublicKey;
  holderAta: PublicKey;
  decimals: number;
  amount: bigint;
  holderKeypair: Keypair;
  dexterAuthority: PublicKey;
}): Promise<void> {
  const {
    program,
    provider,
    vaultPda,
    claimPda,
    swigAddress,
    swigWalletAddress,
    swigWalletAddrKit,
    mint,
    sourceAta,
    holderAta,
    decimals,
    amount,
    holderKeypair,
    dexterAuthority,
  } = args;

  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  const settleVaultIx = await program.methods
    .settleLockedVoucher({})
    .accountsPartial({
      swig: swigAddress,
      swigWalletAddress,
      claim: claimPda,
      vault: vaultPda,
      holder: holderKeypair.publicKey,
      dexterAuthority,
    })
    .instruction();

  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(sourceAta.toBase58()),
      mint: kitAddress(mint.toBase58()),
      destination: kitAddress(holderAta.toBase58()),
      authority: swigWalletAddrKit,
      amount,
      decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS }
  );

  const swigForSign = await fetchSwig(
    rpc as any,
    kitAddress(swigAddress.toBase58())
  );
  if (!swigForSign) throw new Error("Swig not visible for sign");

  // Role 2 = settle_locked_voucher marker (added by
  // registerSettleLockedVoucherMarker above).
  const signKitIxs = await getSignInstructions(
    swigForSign,
    2,
    [transferKitIx],
    false,
    {
      payer: kitAddress(wallet.publicKey.toBase58()),
      preInstructions: [settleVaultIx as any],
    }
  );
  const signWeb3Ixs = kitInstructionsToWeb3(signKitIxs);

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ...signWeb3Ixs
  );
  await provider.sendAndConfirm(tx, [holderKeypair]);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("settle_locked_voucher — happy path", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("settles a Pending claim: claim status Pending → Settled, settled_at set, recovered_at null, accumulators rebalance, holder USDC rises by amount", async function () {
    this.timeout(600_000);

    const sellerKeypair = Keypair.generate();
    const { ctx, claimPda, voucher } = await setupLockedClaim({
      program,
      provider,
      sellerKeypair,
    });

    // Add the settle_locked_voucher ProgramExec marker (role 2) on this
    // fresh Swig.
    await registerSettleLockedVoucherMarker({
      provider,
      swigAddress: ctx.swigAddress,
      vaultProgramId: program.programId,
    });

    // Seller (current_holder) needs an ATA to receive the settle output.
    const wallet = (provider.wallet as anchor.Wallet).payer;
    const holderAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      ctx.mint,
      sellerKeypair.publicKey
    );

    // Snapshot pre-state.
    const vaultPre = await program.account.vault.fetch(ctx.vaultPda);
    const outstandingPre = BigInt(
      (vaultPre as any).outstandingLockedAmount.toString()
    );
    const settledPre = BigInt(
      (vaultPre as any).totalSettledAmount.toString()
    );
    const crystallizedPre = BigInt(
      (vaultPre as any).totalCrystallizedAmount.toString()
    );

    const claimPre = await program.account.lockedClaim.fetch(claimPda);
    const amount = BigInt(claimPre.amount.toString());
    expect(amount).to.equal(1_000_000n);
    expect(claimPre.status).to.deep.equal({ pending: {} });
    expect(claimPre.currentHolder.toString()).to.equal(
      sellerKeypair.publicKey.toString()
    );

    const holderAtaPre = await getAccount(
      provider.connection,
      holderAta,
      "finalized"
    );
    const holderBalancePre = holderAtaPre.amount;

    // Settle (atomic vault::settle_locked_voucher + swig::SignV2).
    await settleLockedAtomic({
      program,
      provider,
      vaultPda: ctx.vaultPda,
      claimPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      swigWalletAddrKit: ctx.swigWalletAddrKit,
      mint: ctx.mint,
      sourceAta: ctx.sourceAta,
      holderAta,
      decimals: ctx.decimals,
      amount,
      holderKeypair: sellerKeypair,
      dexterAuthority: provider.wallet.publicKey,
    });

    // Claim: Pending → Settled, settled_at set, recovered_at still null,
    // current_holder unchanged.
    const claimPost = await pollUntilAccount(
      () => program.account.lockedClaim.fetch(claimPda),
      (c: any) => "settled" in c.status,
    );
    expect(claimPost.status).to.deep.equal({ settled: {} });
    expect(claimPost.settledAt).to.not.equal(null);
    expect(claimPost.recoveredAt).to.equal(null);
    expect(claimPost.amount.toString()).to.equal(amount.toString());
    expect(claimPost.currentHolder.toString()).to.equal(
      sellerKeypair.publicKey.toString()
    );

    // Vault accumulators: outstanding falls by amount; total_settled rises
    // by amount; total_crystallized untouched (Decision 1 says only
    // lock_voucher writes that field).
    const vaultPost = await program.account.vault.fetch(ctx.vaultPda);
    expect((vaultPost as any).outstandingLockedAmount.toString()).to.equal(
      (outstandingPre - amount).toString()
    );
    expect((vaultPost as any).totalSettledAmount.toString()).to.equal(
      (settledPre + amount).toString()
    );
    expect((vaultPost as any).totalCrystallizedAmount.toString()).to.equal(
      crystallizedPre.toString()
    );

    // Holder USDC ATA: balance rose by amount.
    const holderAtaPost = await getAccount(
      provider.connection,
      holderAta,
      "finalized"
    );
    expect((holderAtaPost.amount - holderBalancePre).toString()).to.equal(
      amount.toString()
    );

    // Quiet the linter on `voucher` (kept in scope to mirror sibling tests
    // and aid debugging).
    void voucher;
  });
});

describe("settle_locked_voucher — wrong holder rejection", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects a settle signed by an imposter (not current_holder)", async function () {
    this.timeout(600_000);

    const sellerKeypair = Keypair.generate();
    const imposter = Keypair.generate();
    const { ctx, claimPda } = await setupLockedClaim({
      program,
      provider,
      sellerKeypair,
    });

    await registerSettleLockedVoucherMarker({
      provider,
      swigAddress: ctx.swigAddress,
      vaultProgramId: program.programId,
    });

    const wallet = (provider.wallet as anchor.Wallet).payer;
    const imposterAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      ctx.mint,
      imposter.publicKey
    );

    let threw = false;
    try {
      await settleLockedAtomic({
        program,
        provider,
        vaultPda: ctx.vaultPda,
        claimPda,
        swigAddress: ctx.swigAddress,
        swigWalletAddress: ctx.swigWalletAddress,
        swigWalletAddrKit: ctx.swigWalletAddrKit,
        mint: ctx.mint,
        sourceAta: ctx.sourceAta,
        holderAta: imposterAta,
        decimals: ctx.decimals,
        amount: 1_000_000n,
        holderKeypair: imposter,
        dexterAuthority: provider.wallet.publicKey,
      });
    } catch (err: any) {
      threw = true;
      // The constraint `claim.current_holder == holder.key()` raises
      // `PasskeyVerificationFailed` per the handler's `@` mapping. Anchor
      // may surface the constraint failure as either the mapped name or a
      // raw constraint error — accept either.
      expect(err.toString()).to.match(/PasskeyVerificationFailed|ConstraintRaw/);
    }
    expect(
      threw,
      "settle_locked_voucher should have been rejected (wrong holder)"
    ).to.equal(true);
  });
});

describe("settle_locked_voucher — double-settle rejection", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects a second settle on the same claim (status is Settled, not Pending)", async function () {
    this.timeout(600_000);

    const sellerKeypair = Keypair.generate();
    const { ctx, claimPda } = await setupLockedClaim({
      program,
      provider,
      sellerKeypair,
    });

    await registerSettleLockedVoucherMarker({
      provider,
      swigAddress: ctx.swigAddress,
      vaultProgramId: program.programId,
    });

    const wallet = (provider.wallet as anchor.Wallet).payer;
    const holderAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      ctx.mint,
      sellerKeypair.publicKey
    );

    // First settle — succeeds.
    await settleLockedAtomic({
      program,
      provider,
      vaultPda: ctx.vaultPda,
      claimPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      swigWalletAddrKit: ctx.swigWalletAddrKit,
      mint: ctx.mint,
      sourceAta: ctx.sourceAta,
      holderAta,
      decimals: ctx.decimals,
      amount: 1_000_000n,
      holderKeypair: sellerKeypair,
      dexterAuthority: provider.wallet.publicKey,
    });

    // Confirm Settled before attempting the second.
    await pollUntilAccount(
      () => program.account.lockedClaim.fetch(claimPda),
      (c: any) => "settled" in c.status,
    );

    // Second settle — must be rejected (claim.status == Pending constraint
    // fires because status is now Settled).
    let threw = false;
    try {
      await settleLockedAtomic({
        program,
        provider,
        vaultPda: ctx.vaultPda,
        claimPda,
        swigAddress: ctx.swigAddress,
        swigWalletAddress: ctx.swigWalletAddress,
        swigWalletAddrKit: ctx.swigWalletAddrKit,
        mint: ctx.mint,
        sourceAta: ctx.sourceAta,
        holderAta,
        decimals: ctx.decimals,
        amount: 1_000_000n,
        holderKeypair: sellerKeypair,
        dexterAuthority: provider.wallet.publicKey,
      });
    } catch (err: any) {
      threw = true;
      // The `claim.status == Pending` constraint maps to
      // `LockRangeAlreadyClaimed` via the handler's `@`. Accept either the
      // mapped name or a raw constraint error.
      expect(err.toString()).to.match(/LockRangeAlreadyClaimed|ConstraintRaw/);
    }
    expect(
      threw,
      "second settle_locked_voucher should have been rejected (status != Pending)"
    ).to.equal(true);
  });
});
