// V6 MULTI-SESSION × WITHDRAWAL-RESERVATION — the last open question of the V6
// migration: does spreading session exposure across N per-counterparty
// SessionAccount PDAs (each with its own revolving `current_outstanding` meter)
// change the withdrawal-reservation semantics? This file PROVES it does not.
//
// ────────────────────────────────────────────────────────────────────────────
// RUN CONTEXT
//   Runs against deployed-V6-on-mainnet; gated on the V6 deploy + Helius RPC.
//   The passkey path uses the mainnet secp256r1 precompile (SIMD-0075); the
//   settle/lock paths move real USDC via Swig::SignV2, and the withdrawal
//   ceremony is passkey-signed. MAINNET integration test driven through
//   `makeTestProvider` (ANCHOR_PROVIDER_URL / ANCHOR_WALLET). WRITE-ONLY at
//   authoring time — type-checked but NOT executed (Helius was down). It runs
//   as part of the post-deploy V6 suite alongside multisession-lifecycle.ts,
//   multisession-overcommit.ts, and finalize-withdrawal-reservation.ts.
// ────────────────────────────────────────────────────────────────────────────
//
// THE DESIGN BELIEF (proven below, and CONFIRMED by reading the source):
//
//   finalize_withdrawal.rs gates on TWO vault-level aggregates, NOT on any
//   per-session field:
//     [line  88]  require!(vault.pending_voucher_count == 0, PendingVouchersExist)
//     [line 111]  require!(live_balance_after >= vault.outstanding_locked_amount, …)
//   (and the V5 credit pin on `borrowed`, line 125 — not exercised here).
//
//   `outstanding_locked_amount` is the CRYSTALLIZED LockedClaim tier. It is a
//   single u64 on the Vault account. lock_voucher.rs raises it by the locked
//   delta and creates a LockedClaim PDA; settle_voucher.rs does NOT touch it.
//   It is therefore VAULT-LEVEL and UNCHANGED by V6 — multiple sessions locking
//   all accumulate into this one odometer (Property 3).
//
//   `current_outstanding` is the REVOLVING per-session meter. It lives on each
//   SessionAccount PDA, is raised by settle_voucher(increment=true), released on
//   settle, and is NOWHERE referenced by finalize_withdrawal. It was never a
//   withdrawal gate — not in V5, not in V6 (Property 1).
//
//   Both request_withdrawal.rs (line 31) and finalize_withdrawal.rs (line 90)
//   now ADMIT VAULT_VERSION_V6 in their version `require!`, so a V6 vault can
//   drive the full request → cooling-off → finalize ceremony. (The stale comment
//   in withdrawal-flow.ts about a "version wall" excluding V6 pre-dates that
//   widening; it is no longer true.)
//
// PROPERTIES
//   1  revolving exposure ALONE does not block a withdrawal
//        (sessions with current_outstanding history, but locked tier == 0,
//         pending count == 0 → finalize SUCCEEDS)
//   2  the crystallized reservation DOES block (single lock, multi-session vault)
//   3  the reservation is VAULT-LEVEL, summed across sessions' locks
//        (lock on 2 sessions → outstanding_locked_amount == lockA + lockB; a
//         withdrawal below that sum reverts)
//   4  pending_voucher_count is vault-level — an OPEN tab on ANY session blocks
//        finalize (PendingVouchersExist)
//
// APPARATUS
//   The V6 settle/lock/openTab inline apparatus is copied from
//   multisession-lifecycle.ts (it is V6-correct: passes the session PDA +
//   allowed_counterparty the V6 instructions require). The withdrawal ceremony
//   (request/finalize, passkey-signed, REAL bound swig + REAL funded ATA) is
//   copied from the rewritten withdrawal-flow.ts / finalize-withdrawal-
//   reservation.ts. Unlike the single-session reservation test, here MULTIPLE
//   sessions share ONE bootstrapped vault, so the gates are exercised against a
//   genuinely multi-session vault state.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
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
  requestWithdrawalMessage,
  finalizeWithdrawalMessage,
  makeTestProvider,
  createAtaIdempotentFinalized,
  pollUntilAccount,
  P256Keypair,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  registerSessionV2,
  kitInstructionsToWeb3,
  RegisterReadyVault,
} from "./helpers/register-bootstrap";

import { fetchSwig, getSignInstructions } from "@swig-wallet/kit";
import { address as kitAddress, createSolanaRpc } from "@solana/kit";
import {
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { sha256 } from "@noble/hashes/sha256";

// 44-byte canonical voucher payload (channel_id || cumulative u64-LE ||
// sequence u32-LE) — byte-for-byte identical to settle_tab_voucher.rs /
// lock_voucher.rs and the SDK's voucherPayloadMessage.
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

describe("V6 multi-session × withdrawal-reservation (the last open question)", () => {
  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  const wallet = (provider.wallet as anchor.Wallet).payer;
  const rpc = createSolanaRpc(provider.connection.rpcEndpoint);

  // A session registered against a fixed counterparty on a SHARED vault, plus
  // that counterparty's settle-credit ATA + a per-session channelId. Multiple
  // of these share ONE RegisterReadyVault so we exercise multi-session state.
  interface SessionCtx {
    seller: PublicKey;
    sessionKeypair: Keypair;
    sessionPda: PublicKey;
    channelId: Uint8Array;
    sellerAta: PublicKey;
  }

  // Register one session bound to a fresh `seller` on the GIVEN vault, create
  // the seller ATA, and return its handle. `siblings` are the already-registered
  // session PDAs on this vault (the V6 overcommit gate requires them as
  // remaining_accounts so it can sum live revolving capacity across sessions).
  async function addSession(
    vault: RegisterReadyVault,
    opts: {
      maxAmount: bigint;
      maxRevolvingCapacity: bigint;
      siblings: PublicKey[];
    },
  ): Promise<SessionCtx> {
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
        siblings: opts.siblings.map((pubkey) => ({ pubkey })),
      },
    );
    const sellerAta = await createAtaIdempotentFinalized(
      provider,
      wallet,
      vault.mint,
      seller,
    );
    const channelId = new Uint8Array(32);
    crypto.getRandomValues(channelId);
    return { seller, sessionKeypair, sessionPda, channelId, sellerAta };
  }

  // settle_voucher(increment=true) — RISE seam against the V6 session PDA.
  // Raises this session's current_outstanding (the revolving meter) and bumps
  // the vault-level pending_voucher_count. Does NOT touch outstanding_locked.
  async function openTab(
    vault: RegisterReadyVault,
    s: SessionCtx,
    amount: bigint,
  ): Promise<void> {
    await program.methods
      .settleVoucher({
        amount: new BN(amount.toString()),
        increment: true,
        allowedCounterparty: s.seller,
      })
      .accountsPartial({
        vault: vault.vaultPda,
        dexterAuthority: provider.wallet.publicKey,
        session: s.sessionPda,
      })
      .rpc();
  }

  // settle_tab_voucher against the named V6 session PDA via Swig::SignV2.
  // Advances `spent` to the cumulative and RELEASES current_outstanding back
  // toward 0; decrements pending_voucher_count. Three atomic instructions:
  //   [N-1] Ed25519 precompile over the 44-byte voucher (session key signs)
  //   [N  ] vault::settle_tab_voucher (session PDA + allowed_counterparty)
  //   [N+1] swig::SignV2(TransferChecked) — increment → seller ATA, role-1 marker
  async function settleTab(
    vault: RegisterReadyVault,
    s: SessionCtx,
    cumulativeAmount: bigint,
    sequenceNumber: number,
  ): Promise<void> {
    const before: any = await program.account.sessionAccount.fetch(s.sessionPda);
    const priorSpent = BigInt(before.session.spent.toString());
    if (cumulativeAmount <= priorSpent) {
      throw new Error(
        `cumulativeAmount (${cumulativeAmount}) must exceed prior spent (${priorSpent})`,
      );
    }
    const increment = cumulativeAmount - priorSpent;

    const message = voucherPayloadMessage(
      s.channelId,
      cumulativeAmount,
      sequenceNumber,
    );
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: s.sessionKeypair.secretKey,
      message,
    });

    const settleVaultIx = await program.methods
      .settleTabVoucher({
        channelId: Array.from(s.channelId),
        cumulativeAmount: new BN(cumulativeAmount.toString()),
        sequenceNumber,
        allowedCounterparty: s.seller,
      })
      .accountsPartial({
        swig: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        vault: vault.vaultPda,
        session: s.sessionPda,
        dexterAuthority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const transferKitIx = getTransferCheckedInstruction(
      {
        source: kitAddress(vault.sourceAta.toBase58()),
        mint: kitAddress(vault.mint.toBase58()),
        destination: kitAddress(s.sellerAta.toBase58()),
        authority: vault.swigWalletAddrKit,
        amount: increment,
        decimals: vault.decimals,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );
    const swigForSign = await fetchSwig(
      rpc as any,
      kitAddress(vault.swigAddress.toBase58()),
    );
    if (!swigForSign) throw new Error("Swig not visible for sign");
    const signKitIxs = await getSignInstructions(
      swigForSign,
      1, // role 1 = vault ProgramExec(settle_tab_voucher) marker
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

  // lock_voucher against the named V6 session PDA. Graduates the locked delta
  // into crystallized_cumulative on the PDA AND raises the VAULT-LEVEL
  // outstanding_locked_amount by the same delta (the crystallized tier), and
  // creates a LockedClaim PDA. Two atomic instructions:
  //   [N-1] Ed25519 precompile over the 44-byte voucher (session key signs)
  //   [N  ] vault::lock_voucher (session PDA + allowed_counterparty)
  // lock_voucher does NOT require a prior open (current_outstanding -= delta is
  // a saturating_sub), so locking directly leaves pending_voucher_count == 0 —
  // this isolates the RESERVATION gate from the pending-voucher gate.
  async function lockVoucher(
    vault: RegisterReadyVault,
    s: SessionCtx,
    cumulativeAmount: bigint,
    sequenceNumber: number,
  ): Promise<PublicKey> {
    const message = voucherPayloadMessage(
      s.channelId,
      cumulativeAmount,
      sequenceNumber,
    );
    const voucherHash = sha256(message);
    const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: s.sessionKeypair.secretKey,
      message,
    });

    const [claimPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("locked-claim"),
        vault.vaultPda.toBytes(),
        Buffer.from(voucherHash),
      ],
      program.programId,
    );

    const lockIx = await program.methods
      .lockVoucher({
        channelId: Array.from(s.channelId),
        cumulativeAmount: new BN(cumulativeAmount.toString()),
        sequenceNumber,
        voucherHash: Array.from(voucherHash),
        maturityAt: null,
        holderRecoveryAt: null,
        allowedCounterparty: s.seller,
      })
      .accountsPartial({
        vault: vault.vaultPda,
        vaultUsdcAta: vault.sourceAta,
        swig: vault.swigAddress,
        swigWalletAddress: vault.swigWalletAddress,
        session: s.sessionPda,
        claim: claimPda,
        sellerHolder: provider.wallet.publicKey,
        dexterAuthority: provider.wallet.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await provider.sendAndConfirm(new Transaction().add(ed25519Ix, lockIx));
    return claimPda;
  }

  // ── Withdrawal ceremony (passkey-signed). request_withdrawal queues the
  //    pending withdrawal; finalize_withdrawal runs the two gates + clears it.
  //    Both use the vault's bound passkey and the REAL bound swig + funded ATA
  //    so the Account<TokenAccount> decode succeeds and
  //    vault_usdc_ata.owner == swig_wallet_address holds (the gate's ATA
  //    cross-check at finalize_withdrawal.rs:101). ──────────────────────────
  async function requestWithdrawal(
    vault: RegisterReadyVault,
    amount: bigint,
    destination: PublicKey,
    signedAt: bigint,
  ): Promise<void> {
    const opMsg = requestWithdrawalMessage(amount, destination, signedAt);
    const signed = signOperationWithPasskey(vault.passkey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      vault.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const vaultIx = await program.methods
      .requestWithdrawal({
        amount: new BN(amount.toString()),
        destination,
        signedAt: new BN(signedAt.toString()),
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vault.vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    await provider.sendAndConfirm(
      new Transaction().add(precompileIx, vaultIx),
    );
  }

  // Build the finalize_withdrawal tx (precompile + vault ix). finalize itself
  // only runs the gates and sets pending_withdrawal = None; the actual token
  // move is a SEPARATE Swig::SignV2 the caller would append (out of scope — the
  // gate decision is what we assert). Returns the tx for the caller to send,
  // so success / revert can be asserted per property.
  async function buildFinalizeTx(
    vault: RegisterReadyVault,
    amount: bigint,
    destination: PublicKey,
  ): Promise<Transaction> {
    const opMsg = finalizeWithdrawalMessage(amount, destination);
    const signed = signOperationWithPasskey(vault.passkey, opMsg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      vault.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const vaultIx = await program.methods
      .finalizeWithdrawal({
        clientDataJson: Buffer.from(signed.clientDataJSON),
        authenticatorData: Buffer.from(signed.authenticatorData),
      })
      .accountsPartial({
        vault: vault.vaultPda,
        swig: vault.swigAddress,
        // V0.3 Decision 1: the live read for the reservation invariant. REAL
        // funded ATA so the decode + owner cross-check pass.
        vaultUsdcAta: vault.sourceAta,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();
    return new Transaction().add(precompileIx, vaultIx);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PROPERTY 1 — REVOLVING EXPOSURE ALONE DOES NOT BLOCK A WITHDRAWAL.
  //   2 sessions on one vault. Open a tab on EACH (current_outstanding > 0 on
  //   both — CONFIRMED non-zero). Settle BOTH (current_outstanding released,
  //   spent advanced, pending_voucher_count back to 0). NO lock anywhere, so
  //   outstanding_locked_amount stays 0. Then request + finalize a withdrawal
  //   that leaves the balance well above 0. finalize SUCCEEDS — multi-session
  //   revolving activity left no phantom withdrawal block. This proves
  //   current_outstanding is NOT a withdrawal gate.
  // ───────────────────────────────────────────────────────────────────────────
  it("Property 1 — revolving per-session exposure does NOT block a withdrawal (crystallized tier == 0)", async function () {
    this.timeout(900_000);

    // cooling_off is 0 (bootstrap sets coolingOffSeconds: 0) so finalize can run
    // immediately after request — no cluster-clock wait needed for this property.
    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 20_000_000n, // $20 — covers two tabs + withdrawal headroom
      migrateTo: 6,
    });

    // Two sessions to different counterparties. Session B passes A's PDA as a
    // sibling so the V6 overcommit gate can sum revolving capacity across both.
    const a = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      siblings: [],
    });
    const b = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 2_000_000n,
      siblings: [a.sessionPda],
    });

    // OPEN a tab on EACH → current_outstanding > 0 on both PDAs (CONFIRM).
    await openTab(vault, a, 1_000_000n);
    await openTab(vault, b, 1_500_000n);
    let sa: any = await program.account.sessionAccount.fetch(a.sessionPda);
    let sb: any = await program.account.sessionAccount.fetch(b.sessionPda);
    expect(sa.session.currentOutstanding.toString()).to.equal("1000000");
    expect(sb.session.currentOutstanding.toString()).to.equal("1500000");
    // Two open tabs → pending_voucher_count == 2 (vault-level).
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(2);
    // No lock anywhere → crystallized reservation is still 0.
    expect(v.outstandingLockedAmount.toString()).to.equal("0");

    // SETTLE BOTH tabs → current_outstanding released to 0, pending count to 0.
    await settleTab(vault, a, 1_000_000n, 1);
    await settleTab(vault, b, 1_500_000n, 1);
    sa = await program.account.sessionAccount.fetch(a.sessionPda);
    sb = await program.account.sessionAccount.fetch(b.sessionPda);
    expect(sa.session.currentOutstanding.toString()).to.equal("0");
    expect(sb.session.currentOutstanding.toString()).to.equal("0");
    // The sessions DO carry non-zero `spent` history — the meters were used.
    expect(BigInt(sa.session.spent.toString()) > 0n).to.equal(true);
    expect(BigInt(sb.session.spent.toString()) > 0n).to.equal(true);
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(0);
    expect(v.outstandingLockedAmount.toString()).to.equal("0");

    // Balance after the two settles: $20 − $1 − $1.5 = $17.5 still in the ATA.
    // Withdraw $2 → leaves $15.5 ≥ outstanding_locked_amount (0). Gate passes.
    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 2_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    await requestWithdrawal(vault, withdrawAmount, destination, signedAt);

    // finalize must SUCCEED — no reservation, no pending voucher, multi-session
    // revolving history is irrelevant to the withdrawal gate.
    await provider.sendAndConfirm(
      await buildFinalizeTx(vault, withdrawAmount, destination),
    );

    // pending_withdrawal cleared (poll for replica lag) → finalize ran the
    // success path. THE PROOF: revolving per-session exposure did not block it.
    const cleared = await pollUntilAccount(
      () => program.account.vault.fetch(vault.vaultPda),
      (vv: any) => vv.pendingWithdrawal === null,
    );
    expect(cleared.pendingWithdrawal).to.be.null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PROPERTY 2 — THE CRYSTALLIZED RESERVATION DOES BLOCK (multi-session vault).
  //   2 sessions on one vault. Lock a voucher on ONE session → vault-level
  //   outstanding_locked_amount > 0 (CONFIRM). Request a withdrawal that would
  //   drop the live balance BELOW that reservation. finalize REVERTS with
  //   WithdrawalWouldViolateReservation. Proves the crystallized reservation is
  //   the real gate and it fires the same regardless of multi-session topology.
  // ───────────────────────────────────────────────────────────────────────────
  it("Property 2 — crystallized reservation blocks a withdrawal that would breach it (multi-session)", async function () {
    this.timeout(900_000);

    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n, // $10
      migrateTo: 6,
    });
    const a = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [],
    });
    // A second registered session exists on the vault (multi-session topology)
    // but stays idle — its presence must not change the gate decision.
    await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [a.sessionPda],
    });

    // Lock $5 on session A (no prior open → pending_voucher_count stays 0, so the
    // RESERVATION gate is the one under test, not the pending-voucher gate).
    await lockVoucher(vault, a, 5_000_000n, 1);
    const v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.outstandingLockedAmount.toString()).to.equal("5000000");
    expect(v.pendingVoucherCount).to.equal(0);

    // Withdraw $7 → $10 − $7 = $3 < $5 locked → reservation gate must fire.
    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 7_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    await requestWithdrawal(vault, withdrawAmount, destination, signedAt);

    let threw = false;
    try {
      await provider.sendAndConfirm(
        await buildFinalizeTx(vault, withdrawAmount, destination),
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/WithdrawalWouldViolateReservation/);
    }
    expect(
      threw,
      "withdrawal that would breach the crystallized reservation must revert",
    ).to.equal(true);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PROPERTY 3 — THE RESERVATION IS VAULT-LEVEL, SUMMED ACROSS SESSIONS' LOCKS.
  //   The multi-session-specific property. Lock a voucher on EACH of 2 sessions.
  //   Assert outstanding_locked_amount == lockA + lockB (the single vault-level
  //   odometer correctly ACCUMULATES across sessions — no per-session leakage,
  //   no double-count). Then a withdrawal below the SUMMED reservation reverts.
  //   This is the proof that multi-session locks fold into ONE vault-level
  //   reservation exactly as the V5 single-session lock did.
  // ───────────────────────────────────────────────────────────────────────────
  it("Property 3 — outstanding_locked_amount is the vault-level SUM of all sessions' locks", async function () {
    this.timeout(900_000);

    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n, // $10
      migrateTo: 6,
    });
    const a = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [],
    });
    const b = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [a.sessionPda],
    });

    // Lock $3 on A and $4 on B. Each lock raises the VAULT-LEVEL odometer by its
    // delta; no prior opens → pending_voucher_count stays 0.
    const lockA = 3_000_000n;
    const lockB = 4_000_000n;
    await lockVoucher(vault, a, lockA, 1);
    await lockVoucher(vault, b, lockB, 1);

    // Confirm each session's crystallized_cumulative carries ITS OWN lock…
    const sa: any = await program.account.sessionAccount.fetch(a.sessionPda);
    const sb: any = await program.account.sessionAccount.fetch(b.sessionPda);
    expect(sa.session.crystallizedCumulative.toString()).to.equal(lockA.toString());
    expect(sb.session.crystallizedCumulative.toString()).to.equal(lockB.toString());

    // …and the VAULT-LEVEL reservation is the SUM of both ($3 + $4 = $7). THE
    // multi-session aggregation proof: no per-session leakage, no double-count.
    const v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.outstandingLockedAmount.toString()).to.equal(
      (lockA + lockB).toString(),
    );
    expect(v.pendingVoucherCount).to.equal(0);

    // A withdrawal below the SUMMED reservation reverts. $10 − $5 = $5 < $7.
    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 5_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    await requestWithdrawal(vault, withdrawAmount, destination, signedAt);

    let threw = false;
    try {
      await provider.sendAndConfirm(
        await buildFinalizeTx(vault, withdrawAmount, destination),
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/WithdrawalWouldViolateReservation/);
    }
    expect(
      threw,
      "withdrawal below the vault-level SUMMED reservation must revert",
    ).to.equal(true);

    // SANITY: a withdrawal that respects the summed reservation succeeds. $10 −
    // $3 = $7 == $7 locked (gate is `>=`, so exactly-at-reservation passes).
    const destOk = Keypair.generate().publicKey;
    const okAmount = 3_000_000n;
    const okSignedAt = BigInt(Math.floor(Date.now() / 1000));
    // Re-request: the prior (rejected) finalize left pending_withdrawal SET, so
    // overwrite it with the new, smaller amount before finalizing.
    await requestWithdrawal(vault, okAmount, destOk, okSignedAt);
    await provider.sendAndConfirm(
      await buildFinalizeTx(vault, okAmount, destOk),
    );
    const cleared = await pollUntilAccount(
      () => program.account.vault.fetch(vault.vaultPda),
      (vv: any) => vv.pendingWithdrawal === null,
    );
    expect(cleared.pendingWithdrawal).to.be.null;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // PROPERTY 4 — pending_voucher_count IS VAULT-LEVEL: AN OPEN TAB ON ANY
  //   SESSION BLOCKS FINALIZE.
  //   2 sessions. Open a tab on the SECOND session only (pending_voucher_count
  //   == 1, no lock anywhere). Request + finalize → REVERTS PendingVouchersExist.
  //   Proves the pending-voucher gate is a vault-level aggregate and a tab on
  //   ANY of the N sessions trips it — confirming finalize_withdrawal.rs:88 sees
  //   one counter, not per-session ones.
  // ───────────────────────────────────────────────────────────────────────────
  it("Property 4 — an open tab on ANY session blocks finalize (PendingVouchersExist, vault-level)", async function () {
    this.timeout(900_000);

    const vault = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: 10_000_000n,
      migrateTo: 6,
    });
    const a = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [],
    });
    const b = await addSession(vault, {
      maxAmount: 5_000_000n,
      maxRevolvingCapacity: 5_000_000n,
      siblings: [a.sessionPda],
    });

    // Open a tab on the SECOND session only → pending_voucher_count == 1.
    await openTab(vault, b, 1_000_000n);
    let v: any = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(1);
    expect(v.outstandingLockedAmount.toString()).to.equal("0"); // no lock

    // Request a modest withdrawal that the RESERVATION would allow ($10 − $2 = $8
    // ≥ 0). The ONLY thing that can block finalize here is the pending voucher —
    // so a revert proves the pending-voucher gate fired, not the reservation.
    const destination = Keypair.generate().publicKey;
    const withdrawAmount = 2_000_000n;
    const signedAt = BigInt(Math.floor(Date.now() / 1000));
    await requestWithdrawal(vault, withdrawAmount, destination, signedAt);

    let threw = false;
    try {
      await provider.sendAndConfirm(
        await buildFinalizeTx(vault, withdrawAmount, destination),
      );
    } catch (err: any) {
      threw = true;
      expect(String(err)).to.match(/PendingVouchersExist/);
    }
    expect(
      threw,
      "an open tab on any session must block finalize via the vault-level pending-voucher gate",
    ).to.equal(true);

    // Counter untouched — the open tab still blocks any drain.
    v = await program.account.vault.fetch(vault.vaultPda);
    expect(v.pendingVoucherCount).to.equal(1);
  });
});
