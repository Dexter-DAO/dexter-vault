// lock_voucher integration tests (mainnet).
//
// Three scenarios cover the Task 3 deliverable:
//   1. Happy path — graduate D from session.current_outstanding to
//      vault.outstanding_locked_amount, create the LockedClaim PDA in pending.
//   2. XOR Test 1 — lock the voucher first, then attempt to settle_tab_voucher
//      the same cumulative range; the frontier guard rejects.
//   3. Over-cap rejection — funding < voucher.cumulative_amount triggers the
//      LockWouldOvercommitVault self-check.
//
// Patterns intentionally mirror tests/revolving-meter.ts so credex can read
// both files side-by-side: the V2 188-byte session registration, the
// kit→web3.js instruction bridge, the swig ProgramExec bootstrap with the
// settle_tab_voucher marker (so XOR Test 1's settle attempt can actually
// reach the on-chain frontier guard), and the post-finality polling discipline.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  Ed25519Program,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha256";
import { expect } from "chai";
import {
  generateP256Keypair,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  setSwigMessage,
  P256Keypair,
  pollUntilAccountExists,
  pollUntilAccount,
  createAtaIdempotentFinalized,
  makeTestProvider,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";
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
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

// settle_tab_voucher's Anchor discriminator — the 8-byte instruction-data
// prefix the swig ProgramExec authority (role 1) validates as a marker.
// XOR Test 1 needs this so the settle attempt actually reaches the on-chain
// frontier guard (otherwise the swig CPI sibling would reject earlier).
const SETTLE_TAB_VOUCHER_DISCRIMINATOR = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);

// Kit v2 → web3.js v1 instruction converter (same shape revolving-meter.ts
// uses; kit's nested @solana/* type duplication forces this cast).
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

// V2 188-byte session registration domain + builder (matches
// register_session_key.rs::build_registration_message under V2 / 188 bytes).
const REGISTER_DOMAIN_V2 = (() => {
  const buf = new Uint8Array(32);
  buf.set(new TextEncoder().encode("OTS_SESSION_REGISTER_V2"), 0);
  return buf;
})();

function sessionRegisterMessageV2(args: {
  programId: PublicKey;
  vaultPda: PublicKey;
  sessionPubkey: Uint8Array;
  maxAmount: bigint;
  expiresAt: bigint;
  allowedCounterparty: PublicKey;
  nonce: number;
  maxRevolvingCapacity: bigint;
}): Uint8Array {
  if (args.sessionPubkey.length !== 32) throw new Error("sessionPubkey must be 32 bytes");
  const buf = new Uint8Array(188);
  const view = new DataView(buf.buffer);
  let o = 0;
  buf.set(REGISTER_DOMAIN_V2, o); o += 32;
  buf.set(args.programId.toBytes(), o); o += 32;
  buf.set(args.vaultPda.toBytes(), o); o += 32;
  buf.set(args.sessionPubkey, o); o += 32;
  view.setBigUint64(o, args.maxAmount, true); o += 8;
  view.setBigInt64(o, args.expiresAt, true); o += 8;
  buf.set(args.allowedCounterparty.toBytes(), o); o += 32;
  view.setUint32(o, args.nonce >>> 0, true); o += 4;
  view.setBigUint64(o, args.maxRevolvingCapacity, true); o += 8;
  if (o !== 188) throw new Error(`session register message wrong length: ${o}`);
  return buf;
}

// 44-byte canonical voucher payload. MUST match settle_tab_voucher.rs and
// lock_voucher.rs byte-for-byte (channel_id || cumulative_amount u64-LE ||
// sequence_number u32-LE).
function voucherPayloadMessage(
  channelId: Uint8Array,
  cumulativeAmount: bigint,
  sequenceNumber: number
): Uint8Array {
  if (channelId.length !== 32) throw new Error("channelId must be 32 bytes");
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  buf.set(channelId, 0);
  view.setBigUint64(32, cumulativeAmount, true);
  view.setUint32(40, sequenceNumber >>> 0, true);
  return buf;
}

interface LockableVaultContext {
  vaultPda: PublicKey;
  sessionKeypair: Keypair;
  /** Passkey bound to the vault at initialize_vault. Required by tests
   *  that need to sign vault-level operations (request_withdrawal,
   *  finalize_withdrawal) after enrollment. */
  passkey: P256Keypair;
  /** channelId is bound to vaultPda for lock_voucher tests (the on-chain
   *  handler doesn't enforce that link, but the seam spec convention is
   *  channelId == vault for the Tab use case). */
  channelId: Uint8Array;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  swigWalletAddrKit: ReturnType<typeof kitAddress>;
  mint: PublicKey;
  /** swig-wallet-owned USDC ATA — the lock_voucher self-check reads
   *  its `amount` field; the settle path debits it via the swig CPI. */
  sourceAta: PublicKey;
  sellerAta: PublicKey;
  sellerOwner: PublicKey;
  decimals: number;
}

interface EnrollOpts {
  /** Funding amount for the swig wallet ATA, in 6-decimal token units.
   *  Maps to the `usdcFundingAmount` parameter in the plan brief. */
  usdcFundingAmount: bigint;
  maxAmount: bigint;
  maxRevolvingCapacity: bigint;
}

/**
 * Fresh-vault provisioning: initialize V4 vault, register V2 session,
 * stand up real swig (role 0 manageAuthority + role 1 ProgramExec(vault,
 * settle_tab_voucher)), mint + fund the swig-wallet USDC ATA. The
 * settle_tab_voucher marker on role 1 is what lets XOR Test 1's settle
 * attempt actually run the frontier guard (the lock side doesn't CPI
 * through swig, so it needs no marker — but the test's settle leg does).
 */
async function enrollLockableVault(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: EnrollOpts
): Promise<LockableVaultContext> {
  const wallet = (provider.wallet as anchor.Wallet).payer;

  // Task 8 made register_session_key require the swig + vault_usdc_ata triple
  // and enforce the overcommit invariant against the live ATA balance. So the
  // order is: initialize_vault → swig create/add/set → fund ATA → register.
  // The bootstrap helper handles the pre-step; we then register against the
  // funded ATA so the gate `maxAmount + 0 ≤ funding` holds trivially.
  const bootstrap = await bootstrapForRegister(program, provider, {
    usdcFundingAmount: opts.usdcFundingAmount,
  });

  const { sessionKeypair } = await registerSessionV2(program, provider, {
    vaultPda: bootstrap.vaultPda,
    passkey: bootstrap.passkey,
    vaultUsdcAta: bootstrap.sourceAta,
    swigAddress: bootstrap.swigAddress,
    swigWalletAddress: bootstrap.swigWalletAddress,
    maxAmount: opts.maxAmount,
    maxRevolvingCapacity: opts.maxRevolvingCapacity,
  });

  const sellerOwner = Keypair.generate().publicKey;
  const sellerAta = await createAtaIdempotentFinalized(
    provider,
    wallet,
    bootstrap.mint,
    sellerOwner,
  );

  // For lock_voucher: convention is channelId == vaultPda.toBytes() (the
  // brief spec uses `channelId: vaultPda.toBytes()` so we follow it).
  const channelId = bootstrap.vaultPda.toBytes();

  return {
    vaultPda: bootstrap.vaultPda,
    sessionKeypair,
    passkey: bootstrap.passkey,
    channelId,
    swigAddress: bootstrap.swigAddress,
    swigWalletAddress: bootstrap.swigWalletAddress,
    swigWalletAddrKit: bootstrap.swigWalletAddrKit,
    mint: bootstrap.mint,
    sourceAta: bootstrap.sourceAta,
    sellerAta,
    sellerOwner,
    decimals: bootstrap.decimals,
  };
}

// settle_voucher(increment=true, amount=X) — credex meter RISE seam.
async function openTab(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  amount: bigint
): Promise<void> {
  await program.methods
    .settleVoucher({ amount: new anchor.BN(amount.toString()), increment: true })
    .accountsPartial({ vault: vaultPda, dexterAuthority: provider.wallet.publicKey })
    .rpc();
}

interface SignedVoucher {
  message: Uint8Array;
  voucherHash: Uint8Array;
  precompileIx: TransactionInstruction;
  cumulativeAmount: bigint;
  sequenceNumber: number;
  channelId: Uint8Array;
}

function buildSessionSignedVoucher(args: {
  sessionKeypair: Keypair;
  channelId: Uint8Array;
  cumulativeAmount: bigint;
  sequenceNumber: number;
}): SignedVoucher {
  const message = voucherPayloadMessage(
    args.channelId,
    args.cumulativeAmount,
    args.sequenceNumber,
  );
  const precompileIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: args.sessionKeypair.secretKey,
    message,
  });
  const voucherHash = sha256(message);
  return {
    message,
    voucherHash,
    precompileIx,
    cumulativeAmount: args.cumulativeAmount,
    sequenceNumber: args.sequenceNumber,
    channelId: args.channelId,
  };
}

async function buildLockVoucherIx(args: {
  program: Program<DexterVault>;
  vaultPda: PublicKey;
  swigAddress: PublicKey;
  swigWalletAddress: PublicKey;
  vaultUsdcAta: PublicKey;
  voucher: SignedVoucher;
  sellerHolder: PublicKey;
  dexterAuthority: PublicKey;
  payer: PublicKey;
  maturityAt: bigint | null;
  holderRecoveryAt: bigint | null;
}): Promise<TransactionInstruction> {
  const [claimPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("locked-claim"),
      args.vaultPda.toBytes(),
      Buffer.from(args.voucher.voucherHash),
    ],
    args.program.programId
  );

  return await args.program.methods
    .lockVoucher({
      channelId: Array.from(args.voucher.channelId),
      cumulativeAmount: new anchor.BN(args.voucher.cumulativeAmount.toString()),
      sequenceNumber: args.voucher.sequenceNumber,
      voucherHash: Array.from(args.voucher.voucherHash),
      maturityAt: args.maturityAt === null
        ? null
        : new anchor.BN(args.maturityAt.toString()),
      holderRecoveryAt: args.holderRecoveryAt === null
        ? null
        : new anchor.BN(args.holderRecoveryAt.toString()),
    })
    .accountsPartial({
      vault: args.vaultPda,
      vaultUsdcAta: args.vaultUsdcAta,
      swig: args.swigAddress,
      swigWalletAddress: args.swigWalletAddress,
      claim: claimPda,
      sellerHolder: args.sellerHolder,
      dexterAuthority: args.dexterAuthority,
      payer: args.payer,
      systemProgram: SystemProgram.programId,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
}

// settle_tab_voucher wired through swig::SignV2 — the same shape
// revolving-meter.ts's `settle()` uses, parameterized for the lock-voucher
// XOR test where we expect the on-chain frontier guard to reject before the
// CPI executes the transfer.
async function settleTabAtomic(args: {
  program: Program<DexterVault>;
  provider: anchor.AnchorProvider;
  ctx: LockableVaultContext;
  voucher: SignedVoucher;
}): Promise<void> {
  const { program, provider, ctx, voucher } = args;
  const connection = provider.connection;
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(connection.rpcEndpoint);

  // Read live `spent` to compute the increment, just like revolving-meter.
  const session = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
  if (!session) throw new Error("vault has no active session");
  const priorSpent = BigInt(session.spent.toString());
  if (voucher.cumulativeAmount <= priorSpent) {
    throw new Error(
      `cumulativeAmount (${voucher.cumulativeAmount}) must exceed prior spent (${priorSpent})`
    );
  }
  const increment = voucher.cumulativeAmount - priorSpent;

  const settleVaultIx = await program.methods
    .settleTabVoucher({
      channelId: Array.from(ctx.channelId),
      cumulativeAmount: new anchor.BN(voucher.cumulativeAmount.toString()),
      sequenceNumber: voucher.sequenceNumber,
    })
    .accountsPartial({
      swig: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vault: ctx.vaultPda,
      dexterAuthority: provider.wallet.publicKey,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const transferKitIx = getTransferCheckedInstruction(
    {
      source: kitAddress(ctx.sourceAta.toBase58()),
      mint: kitAddress(ctx.mint.toBase58()),
      destination: kitAddress(ctx.sellerAta.toBase58()),
      authority: ctx.swigWalletAddrKit,
      amount: increment,
      decimals: ctx.decimals,
    },
    { programAddress: TOKEN_PROGRAM_ADDRESS }
  );
  const swigForSign = await fetchSwig(rpc as any, kitAddress(ctx.swigAddress.toBase58()));
  if (!swigForSign) throw new Error("Swig not visible for sign");
  const signKitIxs = await getSignInstructions(
    swigForSign,
    1,
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
    voucher.precompileIx,
    ...signWeb3Ixs
  );
  await provider.sendAndConfirm(tx);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("lock_voucher — happy path", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("locks a voucher: graduates D from session.current_outstanding into vault.outstanding_locked_amount, creates a LockedClaim PDA in pending status", async function () {
    this.timeout(600_000);

    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 2_000_000n,
    });

    await openTab(program, provider, ctx.vaultPda, 1_000_000n);

    const voucher = buildSessionSignedVoucher({
      sessionKeypair: ctx.sessionKeypair,
      channelId: ctx.channelId,
      cumulativeAmount: 1_000_000n,
      sequenceNumber: 1,
    });

    const lockIx = await buildLockVoucherIx({
      program,
      vaultPda: ctx.vaultPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vaultUsdcAta: ctx.sourceAta,
      voucher,
      sellerHolder: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      maturityAt: null,
      holderRecoveryAt: null,
    });

    const tx = new Transaction().add(voucher.precompileIx, lockIx);
    await provider.sendAndConfirm(tx);

    const vault = await pollUntilAccount(
      () => program.account.vault.fetch(ctx.vaultPda),
      (v: any) => v.outstandingLockedAmount.toString() === "1000000",
    );
    const session_post = (vault as any).activeSession;
    expect(session_post.currentOutstanding.toString()).to.equal("0");
    expect(session_post.crystallizedCumulative.toString()).to.equal("1000000");
    expect(session_post.lastLockedSequence).to.equal(1);
    expect((vault as any).outstandingLockedAmount.toString()).to.equal("1000000");
    expect((vault as any).totalCrystallizedAmount.toString()).to.equal("1000000");

    const [claimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("locked-claim"), ctx.vaultPda.toBytes(), Buffer.from(voucher.voucherHash)],
      program.programId
    );
    const claim = await program.account.lockedClaim.fetch(claimPda);
    expect(claim.amount.toString()).to.equal("1000000");
    expect(claim.status).to.deep.equal({ pending: {} });
    expect(claim.currentHolder.toString()).to.equal(provider.wallet.publicKey.toString());
    expect(claim.settledAt).to.equal(null);
    expect(claim.recoveredAt).to.equal(null);
  });
});

describe("lock_voucher — XOR Test 1 (lock-then-tab-settle rejected)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects settle_tab_voucher for a voucher whose cumulative_amount has already been locked (frontier guard fires)", async function () {
    this.timeout(600_000);

    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 10_000_000n,
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 2_000_000n,
    });

    await openTab(program, provider, ctx.vaultPda, 1_000_000n);

    const voucher = buildSessionSignedVoucher({
      sessionKeypair: ctx.sessionKeypair,
      channelId: ctx.channelId,
      cumulativeAmount: 1_000_000n,
      sequenceNumber: 1,
    });

    const lockIx = await buildLockVoucherIx({
      program,
      vaultPda: ctx.vaultPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vaultUsdcAta: ctx.sourceAta,
      voucher,
      sellerHolder: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      maturityAt: null,
      holderRecoveryAt: null,
    });
    await provider.sendAndConfirm(new Transaction().add(voucher.precompileIx, lockIx));

    // Attempt settle_tab_voucher on the SAME voucher — must hit frontier guard.
    let threw = false;
    try {
      await settleTabAtomic({ program, provider, ctx, voucher });
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/LockRangeAlreadyClaimed/);
    }
    expect(threw, "settle_tab_voucher should have been rejected").to.equal(true);
  });
});

describe("lock_voucher — over-cap rejection", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("rejects lock_voucher whose delta + outstanding_locked_amount would exceed vault USDC balance", async function () {
    this.timeout(600_000);

    // ═══ THE ANTI-RUG TEST (and the demo's attack-failure proof) ═══
    //
    // Property: lock_voucher's over-commit guard refuses to crystallize a claim
    // the vault cannot back — `outstanding_locked_amount + delta <= live USDC`.
    // This is the buyer's attack: fund the vault, get a session authorized,
    // DRAIN the USDC back out, then try to lock a claim against the now-empty
    // vault. The chain must reject it (LockWouldOvercommitVault).
    //
    // Why a drain is required (proven by algebra in
    // docs/FINDINGS-lock-overcommit-test.md): with a stable balance, the cap
    // guard + registration gate already guarantee cumulative <= max_amount <=
    // balance, so the over-commit guard is unreachable. It ONLY fires when the
    // live balance DROPS after registration — which is exactly the rug attempt.
    //
    // The drain uses the real settle path (settle_tab_voucher + Swig SignV2),
    // because the vault USDC ATA is owned by the swig wallet PDA and can only
    // be moved by a swig-authorized transfer. So: fund $5, register, open+settle
    // a $4 tab (real USDC leaves → balance drops to $1), then lock $5 → rejected.
    //
    // We provision via enrollLockableVault (NOT registerSettleableVault) for a
    // reason that matters to the arithmetic: registerSettleableVault auto-sizes
    // funding to max(maxAmount, maxRevolvingCapacity) * 4 — it would fund $20,
    // leaving $16 after a $4 drain, and a $5 lock (capped by max_amount) could
    // never exceed it, so the over-commit guard would stay unreachable. The
    // over-commit guard ONLY fires when the live balance drops BELOW the cap.
    // enrollLockableVault gives exact control of funding ($5 == max_amount), and
    // its bootstrap installs the settle_tab_voucher ProgramExec marker on swig
    // role 1, so settleTabAtomic's SignV2 transfer authorizes correctly. The ctx
    // it returns carries every swig field (swigAddress, swigWalletAddress,
    // sourceAta, sellerAta) the drain + lock need.
    const ctx = await enrollLockableVault(program, provider, {
      usdcFundingAmount: 5_000_000n, // $5 funded at registration
      maxAmount: 5_000_000n, // $5 cap — registration passes ($5 + 0 <= $5)
      maxRevolvingCapacity: 5_000_000n,
    });

    // ── Drain: open a $4 tab and settle it via settle_tab_voucher + Swig SignV2.
    //    Real USDC ($4) leaves the swig-wallet-owned vault ATA → live balance
    //    drops from $5 to $1. settleTabAtomic transfers (cumulative − priorSpent)
    //    = ($4 − $0) = $4 and bumps on-chain `spent` to $4.
    await openTab(program, provider, ctx.vaultPda, 4_000_000n);
    const drainVoucher = buildSessionSignedVoucher({
      sessionKeypair: ctx.sessionKeypair,
      channelId: ctx.channelId,
      cumulativeAmount: 4_000_000n,
      sequenceNumber: 1,
    });
    await settleTabAtomic({ program, provider, ctx, voucher: drainVoucher });

    // ── Now attempt to lock $5 against the drained vault. Thread the guards:
    //    G1 frontier: $5 > max(spent $4, crystallized $0) = $4 → PASSES.
    //    G2 cap:      $5 <= max_amount $5                      → PASSES.
    //    delta = cumulative $5 − crystallized $0 = $5.
    //    G3 over-commit: delta $5 + outstanding $0 = $5 > live balance $1
    //                    → REJECTS with LockWouldOvercommitVault ← THE TARGET.
    const voucher = buildSessionSignedVoucher({
      sessionKeypair: ctx.sessionKeypair,
      channelId: ctx.channelId,
      cumulativeAmount: 5_000_000n,
      sequenceNumber: 2,
    });
    const lockIx = await buildLockVoucherIx({
      program,
      vaultPda: ctx.vaultPda,
      swigAddress: ctx.swigAddress,
      swigWalletAddress: ctx.swigWalletAddress,
      vaultUsdcAta: ctx.sourceAta,
      voucher,
      sellerHolder: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      maturityAt: null,
      holderRecoveryAt: null,
    });

    let threw = false;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(voucher.precompileIx, lockIx)
      );
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/LockWouldOvercommitVault/);
    }
    expect(
      threw,
      "lock against a drained vault must be rejected — buyer cannot crystallize an unbacked claim"
    ).to.equal(true);
  });
});

// ── XOR Test 2 (settle-then-lock rejected) lives in tests/xor-tab-then-lock.ts ──
// Re-exports below let that file reuse the helpers without duplicating them.

export {
  enrollLockableVault,
  openTab,
  buildSessionSignedVoucher,
  buildLockVoucherIx,
  settleTabAtomic,
};
export type { LockableVaultContext, SignedVoucher };
