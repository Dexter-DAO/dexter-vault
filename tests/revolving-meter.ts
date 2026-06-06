import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  bootstrapForRegister,
  registerSessionV2,
} from "./helpers/register-bootstrap";
import {
  registerSettleableVault,
  settle,
  type MeterVaultContext,
} from "./helpers/settle";

// The settle_tab_voucher Anchor discriminator — the 8-byte instruction-data
// prefix the Swig ProgramExec authority (role 1 here) validates as a marker.
// Sourced from target/idl/dexter_vault.json (instruction settle_tab_voucher).
// This is the Tab-settle twin of FINALIZE_WITHDRAWAL_DISCRIMINATOR in
// swig-settle-flow.ts; the only difference between this settle flow and that
// withdrawal flow is which marker the ProgramExec authority is bound to.
const SETTLE_TAB_VOUCHER_DISCRIMINATOR = new Uint8Array([
  173, 22, 98, 31, 110, 129, 59, 161,
]);

describe("revolving-meter: state shape", () => {
  const program = anchor.workspace.DexterVault as Program<DexterVault>;
  it("SessionRegistration exposes current_outstanding + max_revolving_capacity", () => {
    const idl = program.idl as any;
    // The in-memory `program.idl` is camelCased by the Anchor Program
    // constructor: the type is `sessionRegistration` and its fields are
    // `maxAmount`, `spent`, etc. (the on-disk JSON keeps snake_case). Assert
    // against the camelCase form to match what `program.idl` actually exposes.
    const s = idl.types.find((t: any) => t.name === "sessionRegistration");
    const fields = s.type.fields.map((f: any) => f.name);
    expect(fields).to.include("currentOutstanding");
    expect(fields).to.include("maxRevolvingCapacity");
    expect(fields).to.include("spent");
  });
});

// ── V2 registration message (188 bytes) ──────────────────────────────
//
// Mirrors build_registration_message in register_session_key.rs AFTER this
// task's change: domain bumped to OTS_SESSION_REGISTER_V2 and
// max_revolving_capacity (u64 LE) appended after nonce. This is deliberately
// a local copy (not the shared sessionRegisterMessage helper, which is still
// V1 / 180 bytes) so this file exercises the new byte layout end-to-end.
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

/**
 * The lean context the registration + open-capture tests need: a vault
 * provisioned (V3) + a session registered via the V2 188-byte passkey
 * ceremony. No Swig, no mint, no ATAs. `open()` only needs `vaultPda` and the
 * provider's dexterAuthority signer, so this is sufficient for everything that
 * does NOT call `settle`.
 */
interface LeanVaultContext {
  vaultPda: PublicKey;
  /** Retained for parity with the heavy context + any future signed-voucher
   *  test that wants to drive settle_voucher with a real session key. */
  sessionKeypair: Keypair;
  /** Stable per-vault channel id (parity with the heavy context). */
  channelId: Uint8Array;
}

/**
 * LEAN: provision a fresh vault whose dexterAuthority is the provider wallet and
 * register a session that endorses both maxAmount and maxRevolvingCapacity via
 * the V2 188-byte passkey ceremony. NOTHING ELSE — no Swig, no mint, no ATAs.
 *
 * This is what the registration + open-capture tests use: they only assert on
 * vault state (the stored cap, current_outstanding) and `open()` (settle_voucher
 * increment) which moves no tokens. Callers destructure `{ vaultPda }` or read
 * `ctx.vaultPda`.
 *
 * For the heavy apparatus the Tab settle path needs (Swig + funded ATAs), use
 * `registerSettleableVault`.
 */
async function registerSessionWithCapacity(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { maxAmount: number; maxRevolvingCapacity: number }
): Promise<LeanVaultContext> {
  // Task 8 made register_session_key require the swig + vault_usdc_ata
  // account triple and enforce the overcommit invariant against the live ATA
  // balance. We can no longer register against a bare vault — every register
  // call now needs Swig + a funded source ATA in place. The bootstrap helper
  // does the full provisioning; we then drive a V2/188 registration with
  // funding sized so combined = maxAmount + 0 ≤ funding holds trivially.
  const maxAmount = BigInt(opts.maxAmount);
  const maxRevolvingCapacity = BigInt(opts.maxRevolvingCapacity);
  // Fund well above maxAmount so the gate passes by a wide margin.
  const usdcFundingAmount = maxAmount * 4n + 1_000_000n;

  const bootstrap = await bootstrapForRegister(program, provider, {
    usdcFundingAmount,
  });

  const { sessionKeypair } = await registerSessionV2(program, provider, {
    vaultPda: bootstrap.vaultPda,
    passkey: bootstrap.passkey,
    vaultUsdcAta: bootstrap.sourceAta,
    swigAddress: bootstrap.swigAddress,
    swigWalletAddress: bootstrap.swigWalletAddress,
    maxAmount,
    maxRevolvingCapacity,
  });

  const channelId = new Uint8Array(32);
  crypto.getRandomValues(channelId);

  return { vaultPda: bootstrap.vaultPda, sessionKeypair, channelId };
}

describe("revolving-meter: registration", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // NOTE: the "state shape" describe above touches `anchor.workspace` before any
  // provider is set, which caches the workspace program against Anchor's default
  // localnet provider (http://127.0.0.1:8899). Re-binding the workspace program
  // to our mainnet test provider here keeps the registration ceremony (which
  // sends real txs) pointed at mainnet instead of dead localhost.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("stores max_revolving_capacity, zeroes current_outstanding", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.maxRevolvingCapacity.toNumber()).to.equal(2_000_000);
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(s.spent.toNumber()).to.equal(0);
  });
});

/**
 * Open a tab: settle_voucher with increment=true and a value `amount`. This is
 * the credex meter's RISE seam — it raises current_outstanding on the active
 * session, admission-capped by max_revolving_capacity.
 */
async function open(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  vaultPda: PublicKey,
  amount: number
): Promise<void> {
  await program.methods
    .settleVoucher({ amount: new anchor.BN(amount), increment: true })
    .accountsPartial({ vault: vaultPda, dexterAuthority: provider.wallet.publicKey })
    .rpc();
}

describe("revolving-meter: open captures exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to our mainnet test provider (same reason as
  // the "registration" describe above): the "state shape" describe touches
  // anchor.workspace before any provider is set, caching it against dead
  // localhost. These tests send real txs and must point at the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("settle_voucher(increment) raises current_outstanding by amount", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 1_000_000);
    const s = (await program.account.vault.fetch(vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(1_000_000);
  });
  it("rejects an open that exceeds max_revolving_capacity", async () => {
    const { vaultPda } = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, vaultPda, 2_000_000);
    let threw = false;
    try { await open(program, provider, vaultPda, 1); }
    catch (e: any) { threw = true; expect(e.toString()).to.match(/RevolvingCapacityExceeded/); }
    expect(threw).to.equal(true);
  });
});

describe("revolving-meter: settle releases exposure", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to our mainnet test provider (same reason as
  // the describes above): the "state shape" describe touches anchor.workspace
  // before any provider is set, caching it against dead localhost. This test
  // sends real txs and must point at the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("settle_tab_voucher frees current_outstanding by the settle delta", async () => {
    const ctx = await registerSettleableVault(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    await open(program, provider, ctx.vaultPda, 1_000_000);
    await settle(program, provider, ctx.vaultPda, 1_000_000, ctx);
    const s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
    expect(s.currentOutstanding.toNumber()).to.equal(0);
    expect(s.spent.toNumber()).to.equal(1_000_000);
  });
});

describe("revolving-meter: version", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind the workspace program to the mainnet test provider (same reason as
  // the describes above): touching anchor.workspace before a provider is set
  // caches it against dead localhost. registerSessionWithCapacity sends real
  // txs (initialize_vault + register_session_key) and must use the test provider.
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  it("fresh vault is V3", async () => {
    const ctx = await registerSessionWithCapacity(program, provider, {
      maxAmount: 10_000_000, maxRevolvingCapacity: 2_000_000,
    });
    expect((await program.account.vault.fetch(ctx.vaultPda)).version).to.equal(3);
  });
});

describe("revolving-meter: migration", () => {
  // IDL-presence / args-shape test ONLY — deliberately does NOT run on-chain.
  //
  // Why no end-to-end run: a "V2 vault" is the OLD (16-bytes-shorter) layout.
  // This test binary initializes vaults through the CURRENT program, which
  // writes V3 (initialize_vault sets VAULT_VERSION_V3). There is no honest way
  // to mint a genuine V2 account from a V3-initializing program, so we do NOT
  // fake one. Full migration verification (discriminator check, version-byte
  // gate, +16-byte realloc, trailing zero-fill landing current_outstanding=0 +
  // max_revolving_capacity=0, version 2->3) is exercised post-deploy against
  // the 264 real V2 vaults on mainnet — that is the only place a true V2 buffer
  // exists. Here we assert the instruction made it into the program surface.
  const program = anchor.workspace.DexterVault as Program<DexterVault>;

  it("migrateV2ToV3 is present in the IDL", () => {
    const idl = program.idl as any;
    const ix = idl.instructions.find((i: any) => i.name === "migrateV2ToV3");
    expect(ix, "migrateV2ToV3 instruction must exist in the IDL").to.not.equal(undefined);
  });

  it("migrateV2ToV3 takes vault (writable, non-signer), dexter_authority + payer signers", () => {
    const idl = program.idl as any;
    const ix = idl.instructions.find((i: any) => i.name === "migrateV2ToV3");
    const byName = (n: string) => ix.accounts.find((a: any) => a.name === n);

    const vault = byName("vault");
    expect(vault, "vault account").to.not.equal(undefined);
    expect(vault.writable).to.equal(true);
    expect(!!vault.signer).to.equal(false);

    // Authority-gating: dexter_authority must be a signer (mirrors
    // settle_voucher / rotate_dexter_authority).
    const auth = byName("dexterAuthority");
    expect(auth, "dexter_authority account").to.not.equal(undefined);
    expect(auth.signer).to.equal(true);

    // payer funds the realloc rent top-up and must sign + be writable.
    const payer = byName("payer");
    expect(payer, "payer account").to.not.equal(undefined);
    expect(payer.signer).to.equal(true);
    expect(payer.writable).to.equal(true);

    // system_program present (CPI transfer for the rent top-up).
    expect(byName("systemProgram"), "system_program account").to.not.equal(undefined);
  });
});

describe("turnover-demo: credex proof (turnover > 1)", () => {
  const provider = (require("./helpers/secp256r1") as any).makeTestProvider();
  // Re-bind workspace program to the mainnet test provider (same reason as the
  // settle describe above).
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);

  it("same $2 capacity clears $10 of settled claims => 5x turnover", async function () {
    this.timeout(600_000); // ~20 mainnet txs @ ~13s each

    const REVOLVING = 2_000_000;   // $2 revolving capacity
    const CLAIM = 1_000_000;       // $1 per tab
    const ROUNDS = 10;             // 10 settled claims = $10 cleared

    console.log(`\n=== CREDEX TURNOVER DEMO ===`);
    console.log(`capacity=$${REVOLVING / 1e6}  claim=$${CLAIM / 1e6}  rounds=${ROUNDS}`);
    console.log(`standing up settleable vault (Swig + mint + ATAs)...`);
    const ctx = await registerSettleableVault(program, provider, {
      maxAmount: 100_000_000,        // $100 lifetime cap (room for 10 cumulative settles)
      maxRevolvingCapacity: REVOLVING,
    });
    console.log(`vault: ${ctx.vaultPda.toBase58()}`);

    let cumulative = 0;
    for (let i = 1; i <= ROUNDS; i++) {
      // OPEN: settle_voucher(increment) raises current_outstanding by CLAIM
      await open(program, provider, ctx.vaultPda, CLAIM);
      let s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
      const outAfterOpen = s.currentOutstanding.toNumber();

      // SETTLE: settle_tab_voucher with the running cumulative total.
      // Each settle moves the delta (cumulative - spent = CLAIM) and frees
      // current_outstanding back down.
      cumulative += CLAIM;
      await settle(program, provider, ctx.vaultPda, cumulative, ctx, { sequenceNumber: i });
      s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
      console.log(
        `round ${String(i).padStart(2)}: open->outstanding=$${outAfterOpen / 1e6}  ` +
        `settle->outstanding=$${s.currentOutstanding.toNumber() / 1e6}  ` +
        `spent=$${s.spent.toNumber() / 1e6}`
      );
    }

    const s = (await program.account.vault.fetch(ctx.vaultPda)).activeSession;
    const settled = s.spent.toNumber();
    const capacity = s.maxRevolvingCapacity.toNumber();
    const turnover = settled / capacity;
    console.log(`\n*** CREDEX PROOF: settled=$${settled / 1e6}  capacity=$${capacity / 1e6}  turnover=${turnover}x ***\n`);

    expect(settled).to.equal(ROUNDS * CLAIM);            // $10 cleared
    expect(s.currentOutstanding.toNumber()).to.equal(0); // fully revolved
    // THE clearing proof. Tightened from `> 1` (which only proves "revolved at
    // all") to the EXACT expected turnover: ROUNDS*CLAIM settled over REVOLVING
    // capacity = 10*$1/$2 = 5x. This catches "revolved, but the wrong amount" —
    // a bug that settled e.g. $3 instead of $10 would pass `> 1` (1.5x) but fail
    // here. Per seam-spec Q-OPEN-3.
    const expectedTurnover = (ROUNDS * CLAIM) / REVOLVING; // = 5
    expect(turnover).to.equal(expectedTurnover);
  });
});
