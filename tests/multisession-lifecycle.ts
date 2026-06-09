// V6 session LIFECYCLE — settle / revoke-as-CLEAR / revival / lock / meter-reset
// (spec §7c, cases 15-18b) + the RELOCATED SOL-010 Mode-B meter-reset proof.
//
// ────────────────────────────────────────────────────────────────────────────
// RUN CONTEXT
//   Runs against deployed-V6-on-mainnet; gated on the V6 deploy + Helius RPC.
//   The passkey path uses the mainnet secp256r1 precompile (SIMD-0075) and the
//   settle/lock paths move real USDC via Swig::SignV2, so this is a MAINNET
//   integration test driven through `makeTestProvider` (ANCHOR_PROVIDER_URL /
//   ANCHOR_WALLET). It is WRITE-ONLY at authoring time — it was type-checked but
//   NOT executed (Helius was down). It runs as part of the post-deploy V6 suite,
//   alongside multisession-overcommit.ts (§7a) and multisession-replace.ts (§7b).
// ────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS PROVES
//   The V6 session lives in a per-counterparty `SessionAccount` PDA at
//   [SESSION_SEED, vault, allowed_counterparty]. Every meter that V5 read off
//   `vault.active_session` now lives on that PDA. These cases prove the full
//   per-PDA lifecycle:
//     15  settle_tab against the named PDA moves `spent` / `current_outstanding`
//     16  revoke = CLEAR not CLOSE (PDA survives, version→0, fields zeroed, count--)
//     17  revival blocked: settle vs a cleared session reverts NoActiveSession;
//         a fresh re-register of the same counterparty succeeds (is_new, count back)
//     18  lock_voucher graduates the frontier on the PDA (crystallized_cumulative)
//     18b THE RELOCATED METER-RESET PROOF: settle so spent>0, THEN replace the
//         SAME counterparty → the four meters reset to 0. This is the SOL-010
//         Mode-B "kill stale state" proof case 13 (multisession-replace.ts) could
//         only do vacuously (it replaced a FRESH session whose meters were already
//         0). Here the meter is GENUINELY non-zero going in — asserted explicitly.
//
// WHY THE settle/lock FLOWS ARE DRIVEN INLINE (not via helpers/settle.ts or
// helpers/lock-voucher's settleTabAtomic)
//   Those helpers are V5-shaped: they read `vault.activeSession` and do NOT pass
//   the V6 `session` PDA account or the `allowed_counterparty` arg the V6
//   settle_tab_voucher / settle_voucher / lock_voucher now require. Re-pointing
//   them is a HELPER change (out of scope for this write-only task), so we drive
//   the three V6 instructions inline here with the PDA + arg wired. The voucher
//   message layout (44 bytes) and the Swig SignV2 ProgramExec marker plumbing are
//   IDENTICAL to the helpers — only the account/arg surface differs (V6 adds the
//   session PDA + allowed_counterparty). The session is registered against a
//   FIXED `seller` counterparty so the PDA seed [SESSION_SEED, vault, seller]
//   matches what settle/lock derive from args.allowed_counterparty = seller.
//
// ASSERTION SHAPE
//   Positive cases fetch `program.account.sessionAccount.fetch(pda)` and assert
//   field-by-field. Negative cases (17's settle-vs-cleared) drive the gate to a
//   revert and match the AnchorError name via expect(err.toString()).to.match(),
//   identical to the sibling V6 files. NoActiveSession is the version!=0 guard.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  Ed25519Program,
} from "@solana/web3.js";
import { expect } from "chai";

import {
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  makeTestProvider,
  sendPrecompilePairResilient,
  sessionRevokeMessage,
  createAtaIdempotentFinalized,
  pollUntilAccount,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
  kitInstructionsToWeb3,
  RegisterReadyVault,
} from "./helpers/register-bootstrap";
import { deriveSessionPda } from "./helpers/session";

import {
  fetchSwig,
  getSignInstructions,
} from "@swig-wallet/kit";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { sha256 } from "@noble/hashes/sha256";

// ── 44-byte canonical voucher payload (channel_id || cumulative u64-LE ||
//    sequence u32-LE). MUST match settle_tab_voucher.rs / lock_voucher.rs and
//    the SDK's voucherPayloadMessage byte-for-byte. ────────────────────────────
function voucherPayloadMessage(
  channelId: Uint8Array,
  cumulativeAmount: bigint,
  sequenceNumber: number,
): Uint8Array {
  if (channelId.length !== 32) throw new Error("channelId must be 32 bytes");
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  buf.set(channelId, 0);
  view.setBigUint64(32, cumulativeAmount, true);
  view.setUint32(40, sequenceNumber >>> 0, true);
  return buf;
}

describe("V6 session lifecycle — settle/revoke-CLEAR/revival/lock/meter-reset (spec §7c)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  // ── Inline V6 settle context. A vault bootstrapped to V6 + a session
  //    registered against a FIXED `seller` counterparty, plus a seller ATA for
  //    the SignV2 credit destination. settleTabV6 / lockVoucherV6 below derive
  //    the session PDA from this seller so the seed matches the on-chain check.
  interface V6SettleCtx {
    vault: RegisterReadyVault;
    seller: PublicKey;
    sessionKeypair: Keypair;
    sessionPda: PublicKey;
    channelId: Uint8Array;
    sellerAta: PublicKey;
  }

  // Stand up a V6 vault, register one session bound to a fresh `seller`, and
  // create the seller ATA. The session's allowed_counterparty IS the seller, so
  // the PDA seed [SESSION_SEED, vault, seller] is the one settle/lock will derive.
  async function standUpSettleCtx(opts: {
    maxAmount: bigint;
    maxRevolvingCapacity: bigint;
    usdcFundingAmount: bigint;
  }): Promise<V6SettleCtx> {
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: opts.usdcFundingAmount,
      migrateTo: 6,
    });
    const seller = Keypair.generate().publicKey;
    const { sessionKeypair, sessionPda } = await registerSessionV2(
      program,
      provider,
      {
        vaultPda: vault.vaultPda,
        passkey: vault.passkey,
        vaultUsdcAta: vault.sourceAta,
        swigAddress: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        maxAmount: opts.maxAmount,
        maxRevolvingCapacity: opts.maxRevolvingCapacity,
        allowedCounterparty: seller,
      },
    );

    // Seller ATA — the settle credit destination (same mint as the vault ATA).
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      vault.mint,
      seller,
    );

    const channelId = new Uint8Array(32);
    crypto.getRandomValues(channelId);

    return { vault, seller, sessionKeypair, sessionPda, channelId, sellerAta };
  }

  // open() — settle_voucher(increment=true) RISE seam against the V6 session PDA.
  // V6 requires the (optional) session account + allowed_counterparty arg on the
  // increment path. Raises current_outstanding, admission-capped by
  // max_revolving_capacity.
  async function openV6(ctx: V6SettleCtx, amount: bigint): Promise<void> {
    await program.methods
      .settleVoucher({
        amount: new anchor.BN(amount.toString()),
        increment: true,
        allowedCounterparty: ctx.seller,
      })
      .accountsPartial({
        vault: ctx.vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: ctx.sessionPda,
      })
      .rpc();
  }

  // settle_tab_voucher against the named V6 session PDA, wired through
  // Swig::SignV2(TransferChecked). Three instructions, atomic:
  //   [N-1] Ed25519 precompile over the 44-byte voucher (session key signs)
  //   [N  ] vault::settle_tab_voucher (passes session PDA + allowed_counterparty)
  //   [N+1] swig::SignV2(TransferChecked) — increment → seller ATA, role 1 marker
  async function settleTabV6(
    ctx: V6SettleCtx,
    cumulativeAmount: bigint,
    opts: { sequenceNumber?: number } = {},
  ): Promise<void> {
    const sequenceNumber = opts.sequenceNumber ?? 1;

    // Increment = cumulative − the PDA's live `spent` (read off the SessionAccount
    // PDA now, NOT vault.active_session — that's the V6 change under test).
    const before: any = await program.account.sessionAccount.fetch(
      ctx.sessionPda,
    );
    const priorSpent = BigInt(before.session.spent.toString());
    if (cumulativeAmount <= priorSpent) {
      throw new Error(
        `cumulativeAmount (${cumulativeAmount}) must exceed prior spent (${priorSpent})`,
      );
    }
    const increment = cumulativeAmount - priorSpent;

    const message = voucherPayloadMessage(
      ctx.channelId,
      cumulativeAmount,
      sequenceNumber,
    );
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: ctx.sessionKeypair.secretKey,
      message,
    });

    const settleVaultIx = await program.methods
      .settleTabVoucher({
        channelId: Array.from(ctx.channelId),
        cumulativeAmount: new anchor.BN(cumulativeAmount.toString()),
        sequenceNumber,
        allowedCounterparty: ctx.seller,
      })
      .accountsPartial({
        swig: ctx.vault.swigAddress,
        swigWalletAddress: ctx.vault.swigWalletAddress,
        vault: ctx.vault.vaultPda,
        session: ctx.sessionPda,
        dexterAuthority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const transferKitIx = getTransferCheckedInstruction(
      {
        source: kitAddress(ctx.vault.sourceAta.toBase58()),
        mint: kitAddress(ctx.vault.mint.toBase58()),
        destination: kitAddress(ctx.sellerAta.toBase58()),
        authority: ctx.vault.swigWalletAddrKit,
        amount: increment,
        decimals: ctx.vault.decimals,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );
    const swigForSign = await fetchSwig(
      rpc as any,
      kitAddress(ctx.vault.swigAddress.toBase58()),
    );
    if (!swigForSign) throw new Error("Swig not visible for sign");
    const signKitIxs = await getSignInstructions(
      swigForSign,
      1, // role 1 = vault ProgramExec(settle_tab_voucher) — the bootstrap marker
      [transferKitIx],
      false,
      {
        payer: kitAddress(wallet.publicKey.toBase58()),
        preInstructions: [settleVaultIx as any],
      },
    );
    const signWeb3Ixs: TransactionInstruction[] =
      kitInstructionsToWeb3(signKitIxs);

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ed25519Ix,
      ...signWeb3Ixs,
    );
    await provider.sendAndConfirm(tx);
  }

  // Build the settle_tab_voucher vault ix ALONE (no SignV2) — used by case 17 to
  // drive the revert against a cleared session. The version!=0 guard fires inside
  // the vault ix, so we don't need the SignV2 leg to observe NoActiveSession; we
  // still prepend the Ed25519 precompile so the verify_session_signed sibling
  // check isn't what fails first.
  async function settleTabVaultIxOnly(
    ctx: V6SettleCtx,
    cumulativeAmount: bigint,
    sequenceNumber: number,
  ): Promise<{ precompile: TransactionInstruction; vaultIx: TransactionInstruction }> {
    const message = voucherPayloadMessage(
      ctx.channelId,
      cumulativeAmount,
      sequenceNumber,
    );
    const precompile = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: ctx.sessionKeypair.secretKey,
      message,
    });
    const vaultIx = await program.methods
      .settleTabVoucher({
        channelId: Array.from(ctx.channelId),
        cumulativeAmount: new anchor.BN(cumulativeAmount.toString()),
        sequenceNumber,
        allowedCounterparty: ctx.seller,
      })
      .accountsPartial({
        swig: ctx.vault.swigAddress,
        swigWalletAddress: ctx.vault.swigWalletAddress,
        vault: ctx.vault.vaultPda,
        session: ctx.sessionPda,
        dexterAuthority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return { precompile, vaultIx };
  }

  // lock_voucher against the named V6 session PDA. Two instructions, atomic:
  //   [N-1] Ed25519 precompile over the 44-byte voucher (session key signs)
  //   [N  ] vault::lock_voucher (session PDA + allowed_counterparty) — graduates
  //         delta into crystallized_cumulative + creates the LockedClaim PDA.
  async function lockVoucherV6(
    ctx: V6SettleCtx,
    cumulativeAmount: bigint,
    sequenceNumber: number,
  ): Promise<PublicKey> {
    const message = voucherPayloadMessage(
      ctx.channelId,
      cumulativeAmount,
      sequenceNumber,
    );
    const voucherHash = sha256(message);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: ctx.sessionKeypair.secretKey,
      message,
    });

    const [claimPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("locked-claim"),
        ctx.vault.vaultPda.toBytes(),
        Buffer.from(voucherHash),
      ],
      program.programId,
    );

    const lockIx = await program.methods
      .lockVoucher({
        channelId: Array.from(ctx.channelId),
        cumulativeAmount: new anchor.BN(cumulativeAmount.toString()),
        sequenceNumber,
        voucherHash: Array.from(voucherHash),
        maturityAt: null,
        holderRecoveryAt: null,
        allowedCounterparty: ctx.seller,
      })
      .accountsPartial({
        vault: ctx.vault.vaultPda,
        vaultUsdcAta: ctx.vault.sourceAta,
        swig: ctx.vault.swigAddress,
        swigWalletAddress: ctx.vault.swigWalletAddress,
        session: ctx.sessionPda,
        claim: claimPda,
        sellerHolder: provider.wallet.publicKey,
        dexterAuthority: provider.wallet.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await provider.sendAndConfirm(
      new Transaction().add(ed25519Ix, lockIx),
    );
    return claimPda;
  }

  // Build + send a revoke_session_key for a session bound to `counterparty`.
  // The passkey signs the 128-byte revocation message that binds the SPECIFIC
  // session_pubkey currently on the PDA. Accounts: vault (mut), the session PDA
  // (mut), instructions sysvar. No Swig, no value move — revoke only clears state.
  async function revokeV6(
    vault: RegisterReadyVault,
    counterparty: PublicKey,
    sessionPubkey: Uint8Array,
  ): Promise<void> {
    const [sessionPda] = deriveSessionPda(
      program.programId,
      vault.vaultPda,
      counterparty,
    );
    const msg = sessionRevokeMessage({
      programId: program.programId,
      vaultPda: vault.vaultPda,
      sessionPubkey,
    });
    const signed = signOperationWithPasskey(vault.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      vault.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const revokeIx = await program.methods
      .revokeSessionKey({
        allowedCounterparty: counterparty,
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vault.vaultPda,
        session: sessionPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    // [precompile, revoke] pair — resilient send + poll the RESULT (the PDA's
    // version is now 0, i.e. cleared). On a transient drop the poll confirms
    // whether the first send landed; a real revert propagates as the thrown error.
    await sendPrecompilePairResilient(
      provider,
      [precompileIx, revokeIx],
      async () => {
        const s: any = await program.account.sessionAccount
          .fetch(sessionPda)
          .catch(() => null);
        return !!s && s.version === 0;
      },
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 15. settle_tab AGAINST THE NAMED PDA — meter moves correctly.
  //     Register a session, open a tab (raise current_outstanding), settle it
  //     (advance spent, release current_outstanding). Assert the moves are read
  //     off the SessionAccount PDA — the V5 revolving-meter test adapted to
  //     sessionAccount.fetch(pda) instead of vault.activeSession.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 15 — settle_tab moves spent / current_outstanding on the named PDA", async function () {
    this.timeout(600_000);

    const ctx = await standUpSettleCtx({
      maxAmount: 10_000_000n, // $10 lifetime cap
      maxRevolvingCapacity: 2_000_000n, // $2 revolving
      usdcFundingAmount: 20_000_000n, // $20 — covers the cap + settle headroom
    });

    // Fresh PDA: both meters 0.
    let s: any = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(s.session.spent.toString()).to.equal("0");
    expect(s.session.currentOutstanding.toString()).to.equal("0");

    // OPEN $1 → current_outstanding rises to $1, spent unchanged.
    await openV6(ctx, 1_000_000n);
    s = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(s.session.currentOutstanding.toString()).to.equal("1000000");
    expect(s.session.spent.toString()).to.equal("0");

    // SETTLE cumulative $1 → spent advances to $1 (== settled amount),
    // current_outstanding released back to 0 (monotonic: spent only rises).
    await settleTabV6(ctx, 1_000_000n, { sequenceNumber: 1 });
    s = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(s.session.spent.toString()).to.equal("1000000"); // == settled
    expect(s.session.currentOutstanding.toString()).to.equal("0"); // released
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 16. REVOKE = CLEAR not CLOSE.
  //     Register A. Revoke it. The PDA STILL EXISTS (not closed — getAccountInfo
  //     non-null, lamports unchanged, owner still the program), version == 0,
  //     the SessionRegistration fields are zeroed, live_session_count decremented.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 16 — revoke clears the PDA in place (not closed): version 0, fields zeroed, count--", async function () {
    this.timeout(600_000);

    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const cpA = Keypair.generate().publicKey;
    const a = await registerSessionV2(program, provider, {
      vaultPda: vault.vaultPda,
      passkey: vault.passkey,
      vaultUsdcAta: vault.sourceAta,
      swigAddress: vault.swigAddress,
      swigWalletAddress: vault.swigWalletAddress,
      maxAmount: 3_000_000n,
      maxRevolvingCapacity: 3_000_000n,
      allowedCounterparty: cpA,
    });

    // Pre-revoke: live, count == 1. Snapshot lamports + owner for the not-closed
    // assertion.
    let aAcct: any = await program.account.sessionAccount.fetch(a.sessionPda);
    expect(aAcct.version).to.not.equal(0);
    const sessionPubkey: Uint8Array = Uint8Array.from(aAcct.session.sessionPubkey);
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
    const preAi = await provider.connection.getAccountInfo(a.sessionPda);
    expect(preAi, "session PDA must exist before revoke").to.not.be.null;
    const preLamports = preAi!.lamports;
    const preOwner = preAi!.owner.toBase58();

    // ── REVOKE ──
    await revokeV6(vault, cpA, sessionPubkey);

    // PDA NOT closed: still on-chain, lamports unchanged, owner still the program.
    const postAi = await provider.connection.getAccountInfo(a.sessionPda);
    expect(postAi, "revoke must NOT close the PDA (clear-not-close)").to.not.be
      .null;
    expect(postAi!.lamports).to.equal(preLamports); // rent parked, not refunded
    expect(postAi!.owner.toBase58()).to.equal(preOwner); // still program-owned

    // version cleared.
    aAcct = await program.account.sessionAccount.fetch(a.sessionPda);
    expect(aAcct.version).to.equal(0);

    // SessionRegistration fields zeroed (the revival-class defense).
    expect(Buffer.from(aAcct.session.sessionPubkey)).to.deep.equal(
      Buffer.alloc(32),
    );
    expect(aAcct.session.maxAmount.toString()).to.equal("0");
    expect(aAcct.session.expiresAt.toString()).to.equal("0");
    expect(aAcct.session.allowedCounterparty.toBase58()).to.equal(
      PublicKey.default.toBase58(),
    );
    expect(aAcct.session.nonce).to.equal(0);
    expect(aAcct.session.spent.toString()).to.equal("0");
    expect(aAcct.session.currentOutstanding.toString()).to.equal("0");
    expect(aAcct.session.maxRevolvingCapacity.toString()).to.equal("0");
    expect(aAcct.session.crystallizedCumulative.toString()).to.equal("0");
    expect(aAcct.session.lastLockedSequence).to.equal(0);

    // live_session_count decremented by 1.
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.liveSessionCount).to.equal(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 17. REVIVAL BLOCKED — settle against a cleared session reverts; re-register
  //     of the same counterparty works (is_new because version==0).
  // ───────────────────────────────────────────────────────────────────────────
  it("case 17 — cleared session: settle reverts NoActiveSession; re-register succeeds, count restored", async function () {
    this.timeout(600_000);

    // Stand up a settle-capable vault + session bound to `seller`, so after we
    // revoke we can attempt a settle against the cleared PDA and re-register.
    const ctx = await standUpSettleCtx({
      maxAmount: 10_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      usdcFundingAmount: 20_000_000n,
    });

    // Snapshot the live session pubkey for the revoke message, confirm count 1.
    let aAcct: any = await program.account.sessionAccount.fetch(ctx.sessionPda);
    const sessionPubkey: Uint8Array = Uint8Array.from(aAcct.session.sessionPubkey);
    let v: any = await program.account.vault.fetch(ctx.vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);

    // ── REVOKE the seller's session (A cleared, version==0). ──
    await revokeV6(ctx.vault, ctx.seller, sessionPubkey);
    aAcct = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(aAcct.version).to.equal(0);
    v = await program.account.vault.fetch(ctx.vault.vaultPda);
    expect(v.liveSessionCount).to.equal(0);

    // ── settle_tab against the CLEARED session → NoActiveSession (version!=0
    //    guard in settle_tab_voucher.rs). We use the precompile + vault-ix-only
    //    path: the version guard fires inside the vault ix before any transfer. ──
    const { precompile, vaultIx } = await settleTabVaultIxOnly(ctx, 1_000_000n, 1);
    let threw = false;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(precompile, vaultIx),
      );
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/NoActiveSession/);
    }
    expect(threw, "settle against a cleared session must revert").to.equal(true);

    // ── RE-REGISTER the same counterparty (fresh values). is_new because the
    //    PDA's version==0, so live_session_count goes back to 1, and the PDA now
    //    carries the new values. No siblings (count is 0 going in → 0 expected). ──
    const fresh = await registerSessionV2(program, provider, {
      vaultPda: ctx.vault.vaultPda,
      passkey: ctx.vault.passkey,
      vaultUsdcAta: ctx.vault.sourceAta,
      swigAddress: ctx.vault.swigAddress,
      swigWalletAddress: ctx.vault.swigWalletAddress,
      maxAmount: 4_000_000n,
      maxRevolvingCapacity: 4_000_000n,
      allowedCounterparty: ctx.seller,
    });
    // Same seed-bound PDA reused in place.
    expect(fresh.sessionPda.toBase58()).to.equal(ctx.sessionPda.toBase58());

    aAcct = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(aAcct.version).to.not.equal(0); // re-written (V1)
    expect(aAcct.session.maxAmount.toString()).to.equal("4000000"); // new values
    v = await program.account.vault.fetch(ctx.vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1); // restored to its prior value
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 18. lock_voucher FRONTIER PRESERVED ON THE PDA.
  //     FOCUSED variant (per brief): a lock_voucher-against-PDA test that asserts
  //     crystallized_cumulative moves on the SessionAccount PDA, and that the XOR
  //     frontier max(spent, crystallized_cumulative) then BLOCKS a same-range
  //     settle. This proves the frontier is read from the PDA-stored values.
  //     (Chosen over re-driving the full xor-tab-then-lock flow, which is V5-
  //     helper-shaped; the focused PDA assertion covers the §7c intent.)
  // ───────────────────────────────────────────────────────────────────────────
  it("case 18 — lock_voucher graduates crystallized_cumulative on the PDA; frontier then blocks a same-range settle", async function () {
    this.timeout(600_000);

    const ctx = await standUpSettleCtx({
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      usdcFundingAmount: 10_000_000n,
    });

    // Open $1 so the session has current_outstanding to graduate from.
    await openV6(ctx, 1_000_000n);
    let s: any = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(s.session.currentOutstanding.toString()).to.equal("1000000");
    expect(s.session.crystallizedCumulative.toString()).to.equal("0");

    // LOCK cumulative $1 → delta $1 graduates:
    //   current_outstanding $1 → $0, crystallized_cumulative $0 → $1.
    const claimPda = await lockVoucherV6(ctx, 1_000_000n, 1);
    s = await pollUntilAccount(
      () => program.account.sessionAccount.fetch(ctx.sessionPda),
      (acct: any) => acct.session.crystallizedCumulative.toString() === "1000000",
    );
    expect(s.session.currentOutstanding.toString()).to.equal("0");
    expect(s.session.crystallizedCumulative.toString()).to.equal("1000000");
    expect(s.session.lastLockedSequence).to.equal(1);
    // The vault-tier odometer rose too, and the claim PDA exists in pending.
    const v: any = await program.account.vault.fetch(ctx.vault.vaultPda);
    expect(v.outstandingLockedAmount.toString()).to.equal("1000000");
    const claim: any = await program.account.lockedClaim.fetch(claimPda);
    expect(claim.amount.toString()).to.equal("1000000");

    // ── FRONTIER GUARD reads the PDA's crystallized_cumulative: a settle for the
    //    SAME cumulative ($1) is rejected because $1 is not > max(spent $0,
    //    crystallized $1) = $1 → LockRangeAlreadyClaimed. This is the XOR frontier
    //    enforced against the PDA-stored value. ──
    const { precompile, vaultIx } = await settleTabVaultIxOnly(ctx, 1_000_000n, 2);
    let threw = false;
    try {
      await provider.sendAndConfirm(
        new Transaction().add(precompile, vaultIx),
      );
    } catch (err: any) {
      threw = true;
      expect(err.toString()).to.match(/LockRangeAlreadyClaimed/);
    }
    expect(
      threw,
      "settle over an already-locked range must hit the PDA-frontier guard",
    ).to.equal(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 18b. THE RELOCATED METER-RESET PROOF (SOL-010 Mode B) — settle-then-replace
  //      zeroes a GENUINELY NON-ZERO meter.
  //
  //      This is the real reset proof that case 13 (multisession-replace.ts) could
  //      only assert vacuously: case 13 replaced a FRESH session whose meters were
  //      already 0, so its "meters == 0 after replace" would pass even if the reset
  //      code were deleted. HERE the meter is non-zero going in:
  //        1. register a session to counterparty A
  //        2. open + settle a tab so spent > 0 (CONFIRMED non-zero before replace)
  //        3. re-register (replace) the SAME counterparty A, no siblings (is_new
  //           false — count(1) − 1 = 0 expected siblings)
  //        4. assert spent / current_outstanding / crystallized_cumulative are all
  //           0 after the replace — the replace RESET a non-zero meter.
  //
  //      The "spent>0 before replace" assertion is made EXPLICIT (settle apparatus:
  //      the inline V6 settleTabV6 above, which fetches the PDA and confirms
  //      spent>0) so a reviewer can see the meter was non-zero going into the
  //      replace. This is the load-bearing case.
  // ───────────────────────────────────────────────────────────────────────────
  it("case 18b — settle-then-replace ZEROES a non-zero meter (the SOL-010 Mode-B reset proof)", async function () {
    this.timeout(600_000);

    // Session bound to `seller` (= counterparty A) so we can settle against it.
    const ctx = await standUpSettleCtx({
      maxAmount: 10_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      usdcFundingAmount: 20_000_000n,
    });
    const cpA = ctx.seller;

    // ── Drive the meter NON-ZERO: open $1, settle $1 → spent == $1. ──
    await openV6(ctx, 1_000_000n);
    await settleTabV6(ctx, 1_000_000n, { sequenceNumber: 1 });

    // EXPLICIT non-vacuity guard: confirm spent > 0 (and current_outstanding back
    // to 0 from the settle) BEFORE the replace. If this isn't non-zero the proof
    // is meaningless — assert it loudly.
    const before: any = await program.account.sessionAccount.fetch(ctx.sessionPda);
    const spentBefore = BigInt(before.session.spent.toString());
    expect(
      spentBefore > 0n,
      `meter must be NON-ZERO before the replace (spent=${spentBefore}) — otherwise the reset proof is vacuous`,
    ).to.equal(true);
    expect(before.session.spent.toString()).to.equal("1000000");

    // ── REPLACE the SAME counterparty A with fresh values, NO siblings (is_new
    //    false → expected siblings = count(1) − 1 = 0). The seed-bound PDA is
    //    reused in place; the handler unconditionally re-zeros the four meters. ──
    const k2 = Keypair.generate();
    const replaced = await registerSessionV2(program, provider, {
      vaultPda: ctx.vault.vaultPda,
      passkey: ctx.vault.passkey,
      vaultUsdcAta: ctx.vault.sourceAta,
      swigAddress: ctx.vault.swigAddress,
      swigWalletAddress: ctx.vault.swigWalletAddress,
      sessionKeypair: k2,
      maxAmount: 7_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      allowedCounterparty: cpA,
      siblings: [],
    });
    // Same PDA — replace-in-place.
    expect(replaced.sessionPda.toBase58()).to.equal(ctx.sessionPda.toBase58());

    // ── THE PROOF: the replace RESET the genuinely-non-zero meter to 0. ──
    const after: any = await program.account.sessionAccount.fetch(ctx.sessionPda);
    expect(after.session.spent.toString()).to.equal("0"); // was $1, now reset
    expect(after.session.currentOutstanding.toString()).to.equal("0");
    expect(after.session.crystallizedCumulative.toString()).to.equal("0");
    expect(after.session.lastLockedSequence).to.equal(0);
    // The new scope landed (so this was a real replace, not a no-op).
    expect(after.session.maxAmount.toString()).to.equal("7000000");
    expect(Buffer.from(after.session.sessionPubkey)).to.deep.equal(
      Buffer.from(k2.publicKey.toBytes()),
    );

    // Count unchanged across the replace (is_new false → no increment).
    const v: any = await program.account.vault.fetch(ctx.vault.vaultPda);
    expect(v.liveSessionCount).to.equal(1);
  });
});
