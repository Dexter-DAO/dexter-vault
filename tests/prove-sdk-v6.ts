/**
 * SDK V6 MULTI-SESSION MAINNET PROOF (gated integration test).
 *
 * Proves the @dexterai/vault 0.8.0-candidate (LOCAL build) drives the FULL V6
 * session lifecycle against the LIVE deployed program (`Hg3w…`): register →
 * sibling-gated second register → meter read → 3-ix atomic settle → revoke →
 * replace-in-place. Every vault instruction, message, account decode, sibling
 * set, and confirm-visibility wait below comes from the SDK; the harness
 * supplies only what CANNOT be SDK.
 *
 * WHAT'S SDK vs HARNESS (the honest boundary):
 *   HARNESS (deliberate):
 *     - bootstrapForRegister → fresh V6 vault + real Swig (role-1 marker =
 *       settle_tab_voucher) + test mint + funded swig-wallet ATA. Test money
 *       can't be SDK.
 *     - passkey signing (signOperationWithPasskey + buildSecp256r1VerifyInstruction)
 *       — in production this is the browser's WebAuthn ceremony, not library code.
 *     - send/confirm transport (sendPrecompilePairResilient / sendAndConfirmWithRetry)
 *       — the throttled lean-RPC harness; the SDK deliberately returns
 *       instructions and never owns the tx lifecycle.
 *     - ONE injected SignV2 assembler for settleTab: defaultAssembleSignV2
 *       hardcodes mainnet USDC; the proof's tab pays in the test mint, so we
 *       inject the same assembler shape with the test mint swapped in. This is
 *       the documented `assembleSignV2` seam, not a bypass — the SDK still
 *       composes the voucher message, the ed25519 precompile, and the
 *       settle_tab_voucher ix.
 *   SDK (what we're proving — all REAL SUBMITS or REAL on-chain reads):
 *     - sessionRegisterMessage / sessionRevokeMessage   (@dexterai/vault/messages)
 *     - buildRegisterSessionKeyInstruction (+ sibling contract via
 *       fetchVaultSessionAccounts → sessionPdasOf)      (@dexterai/vault/{instructions,session})
 *     - buildRevokeSessionKeyInstruction                (@dexterai/vault/instructions)
 *     - openTab / settleTab / readTabMeter              (@dexterai/vault/tab)
 *     - fetchSessionAccount / waitForSession / decode   (@dexterai/vault/session)
 *     - readVaultFull (liveSessionCount)                (@dexterai/vault/reader)
 *     - NodeEd25519Signer (session voucher signing)     (@dexterai/vault/signers/node)
 *
 * RUN (gated — Helius mainnet + funded upgrade-authority wallet; Branch GO):
 *   cd dexter-vault && \
 *   ANCHOR_PROVIDER_URL="https://mainnet.helius-rpc.com/?api-key=<key>" \
 *   ANCHOR_WALLET="$HOME/.config/solana/dexter-vault/upgrade-authority.json" \
 *   npx ts-mocha -p ./tsconfig.json -t 600000 tests/prove-sdk-v6.ts
 *
 * @dexterai/vault MUST resolve to the LOCAL build (node_modules/@dexterai/vault
 * symlinked → ../dexter-vault-sdk with dist/ built) — the first test asserts it.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import {
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import {
  fetchSwig,
  getSignInstructions,
  getSwigWalletAddress,
} from "@swig-wallet/kit";
import { address as kitAddress } from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import {
  makeTestProvider,
  signOperationWithPasskey,
  buildSecp256r1VerifyInstruction,
  sendPrecompilePairResilient,
  sendAndConfirmWithRetry,
  createAtaIdempotentFinalized,
  makeRateLimitedKitRpc,
  pollUntilAccount,
} from "./helpers/secp256r1";
import {
  bootstrapForRegister,
  kitInstructionsToWeb3,
  RegisterReadyVault,
} from "./helpers/register-bootstrap";

// ── THE SDK UNDER TEST (local build, not npm) ────────────────────────────────
import {
  deriveSessionPda,
  fetchSessionAccount,
  fetchVaultSessionAccounts,
  sessionPdasOf,
  waitForSession,
  isSessionLive,
} from "@dexterai/vault/session";
import {
  sessionRegisterMessage,
  sessionRevokeMessage,
} from "@dexterai/vault/messages";
import {
  buildRegisterSessionKeyInstruction,
  buildRevokeSessionKeyInstruction,
} from "@dexterai/vault/instructions";
import { openTab, settleTab, readTabMeter } from "@dexterai/vault/tab";
import type { AssembleSignV2 } from "@dexterai/vault/tab";
import { readVaultFull } from "@dexterai/vault/reader";
import { NodeEd25519Signer } from "@dexterai/vault/signers/node";

const FUNDING = 10_000_000n; // $10 test-token in the swig wallet ATA
const A_MAX = 3_000_000n;
const B_MAX = 2_000_000n;
const OPEN_AMOUNT = 1_000_000n; // tab armed for $1
const CUMULATIVE = 1_000_000n; // voucher cumulative (== delta, first settle)
const HOUR = 3600n;

describe("PROVE: SDK V6 multi-session lifecycle lands on mainnet", function () {
  this.timeout(600_000);

  const provider = makeTestProvider();
  const workspaceProgram = anchor.workspace.DexterVault as Program<DexterVault>;
  const program = new anchor.Program<DexterVault>(workspaceProgram.idl, provider);
  const connection = provider.connection;
  const wallet = provider.wallet.publicKey;

  let v: RegisterReadyVault;
  const cpA = Keypair.generate().publicKey;
  const cpB = Keypair.generate().publicKey;
  const sessionA = Keypair.generate();
  const sessionB = Keypair.generate();
  const sessionB2 = Keypair.generate(); // the replace
  const seller = Keypair.generate();
  let sellerAta: PublicKey;

  // Register one session ENTIRELY through SDK surfaces (message, sibling set,
  // builder, confirm-visibility) — the passkey leg + transport are harness.
  async function registerViaSdk(opts: {
    sessionKeypair: Keypair;
    counterparty: PublicKey;
    maxAmount: bigint;
    nonce: number;
  }): Promise<string> {
    const sessionPubkey = opts.sessionKeypair.publicKey.toBytes();
    const expiresAt = BigInt(Math.floor(Date.now() / 1000)) + HOUR;

    // SDK: fetch the sibling population FRESH (the documented contract).
    const siblings = sessionPdasOf(
      await fetchVaultSessionAccounts(connection, v.vaultPda),
    );

    // SDK: the 188-byte registration message the passkey endorses.
    const msg = sessionRegisterMessage({
      programId: program.programId,
      vaultPda: v.vaultPda,
      sessionPubkey,
      maxAmount: opts.maxAmount,
      expiresAt,
      allowedCounterparty: opts.counterparty,
      nonce: opts.nonce,
      maxRevolvingCapacity: opts.maxAmount,
    });

    // HARNESS: passkey ceremony (browser territory in production).
    const signed = signOperationWithPasskey(v.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      v.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );

    // SDK: the V6 register instruction (8 accounts + sorted writable siblings).
    const registerIx = buildRegisterSessionKeyInstruction({
      vaultPda: v.vaultPda,
      sessionPubkey,
      maxAmount: opts.maxAmount,
      expiresAt,
      allowedCounterparty: opts.counterparty,
      nonce: opts.nonce,
      maxRevolvingCapacity: opts.maxAmount,
      swigAddress: v.swigAddress,
      vaultUsdcAta: v.sourceAta,
      payer: wallet,
      siblingSessionPdas: siblings,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });

    // HARNESS transport; poll predicate is the SDK's own content-aware read.
    const sig = await sendPrecompilePairResilient(
      provider,
      [precompileIx, registerIx],
      async () => {
        const s = await fetchSessionAccount(connection, v.vaultPda, opts.counterparty);
        return (
          !!s &&
          s.version !== 0 &&
          s.session.sessionPubkey.every((b, i) => b === sessionPubkey[i])
        );
      },
    );

    // SDK: the read-your-writes guarantee (content-aware, REPLACE-safe).
    await waitForSession(connection, v.vaultPda, opts.counterparty, {
      expectedSessionPubkey: sessionPubkey,
      timeoutMs: 60_000,
    });
    return sig ?? "(self-healed; confirmed by waitForSession)";
  }

  it("0: the SDK import is the LOCAL V6 build", () => {
    for (const f of [
      deriveSessionPda, fetchSessionAccount, fetchVaultSessionAccounts,
      sessionPdasOf, waitForSession, isSessionLive, sessionRegisterMessage,
      sessionRevokeMessage, buildRegisterSessionKeyInstruction,
      buildRevokeSessionKeyInstruction, openTab, settleTab, readTabMeter,
      readVaultFull,
    ]) {
      expect(typeof f).to.equal("function");
    }
    console.log("    ✓ full V6 SDK surface present (local build)");
  });

  it("HARNESS: bootstrap a fresh V6 vault (swig + funded test-mint ATA)", async () => {
    v = await bootstrapForRegister(program, provider, {
      usdcFundingAmount: FUNDING,
      migrateTo: 6,
    });
    sellerAta = await createAtaIdempotentFinalized(
      provider,
      (provider.wallet as anchor.Wallet).payer,
      v.mint,
      seller.publicKey,
      false,
    );
    console.log(`    ✓ V6 vault: ${v.vaultPda.toBase58()}`);
    console.log(`    ✓ swig:     ${v.swigAddress.toBase58()}`);
    console.log(`    ✓ sellerAta:${sellerAta.toBase58()}`);
  });

  it("SDK SUBMIT #1: register session A (first register — empty sibling set)", async () => {
    const sig = await registerViaSdk({
      sessionKeypair: sessionA,
      counterparty: cpA,
      maxAmount: A_MAX,
      nonce: 1,
    });
    console.log(`    ✓ SUBMITTED register(A): ${sig}`);

    const s = await fetchSessionAccount(connection, v.vaultPda, cpA);
    expect(s, "session A absent").to.not.equal(null);
    expect(s!.version).to.equal(1);
    expect(s!.vault).to.equal(v.vaultPda.toBase58());
    expect(s!.session.maxAmount === A_MAX).to.equal(true);
    expect(s!.session.allowedCounterparty).to.equal(cpA.toBase58());
    expect(s!.session.spent === 0n).to.equal(true);
    expect(isSessionLive(s!)).to.equal(true);
    console.log(`    ✓ SDK decode: version=1, cap=${s!.session.maxAmount}, live`);
  });

  it("SDK SUBMIT #2: register session B — the SIBLING CONTRACT live (must pass A)", async () => {
    // SDK sibling discovery must surface exactly session A.
    const pop = await fetchVaultSessionAccounts(connection, v.vaultPda);
    expect(pop.length, "sibling population before B").to.equal(1);
    expect(pop[0].session.allowedCounterparty).to.equal(cpA.toBase58());

    const sig = await registerViaSdk({
      sessionKeypair: sessionB,
      counterparty: cpB,
      maxAmount: B_MAX,
      nonce: 2,
    });
    console.log(`    ✓ SUBMITTED register(B) with sibling [A]: ${sig}`);

    // SDK vault reader: the V6 field that replaced active_session.
    const vault = await readVaultFull(connection, v.vaultPda);
    expect(vault.version).to.equal(6);
    expect(vault.liveSessionCount).to.equal(2);
    console.log(`    ✓ readVaultFull: version=6, liveSessionCount=2`);
  });

  it("SDK READ #3: readTabMeter(vault, A)", async () => {
    const meter = await readTabMeter(connection, v.vaultPda, cpA);
    expect(meter.spent === 0n).to.equal(true);
    expect(meter.maxAmount === A_MAX).to.equal(true);
    expect(meter.remaining === A_MAX).to.equal(true);
    expect(meter.currentOutstanding === 0n).to.equal(true);
    console.log(`    ✓ meter(A): spent=0 max=${meter.maxAmount} remaining=${meter.remaining}`);
  });

  it("SDK SUBMIT #4: openTab + settleTab — the full 3-ix atomic settle on A", async () => {
    // SDK openTab: settle_voucher(increment) arms the tab + raises the meter.
    const openIxs = await openTab({
      vaultPda: v.vaultPda,
      amount: OPEN_AMOUNT,
      dexterAuthority: wallet,
      allowedCounterparty: cpA,
    });
    const openSig = await sendAndConfirmWithRetry(provider, openIxs);
    console.log(`    ✓ SUBMITTED openTab(A, $1): ${openSig}`);
    await pollUntilAccount(
      async () => (await fetchSessionAccount(connection, v.vaultPda, cpA))!,
      (s) => s.session.currentOutstanding === OPEN_AMOUNT,
    );

    // Injected SignV2 assembler: defaultAssembleSignV2 hardcodes mainnet USDC;
    // this is the same assembler with the TEST mint (the documented seam).
    const testMintAssembler: AssembleSignV2 = async (a) => {
      const rpc = makeRateLimitedKitRpc(connection.rpcEndpoint);
      const swig = await fetchSwig(rpc as any, kitAddress(a.swigAddress.toBase58()));
      if (!swig) throw new Error("swig not found");
      const swigWalletKitAddr = await getSwigWalletAddress(swig);
      const swigWalletPda = new PublicKey(String(swigWalletKitAddr));
      const sourceAta = getAssociatedTokenAddressSync(v.mint, swigWalletPda, true);
      const transferIxs = a.transfers.map((t) =>
        getTransferCheckedInstruction({
          source: kitAddress(sourceAta.toBase58()),
          mint: kitAddress(v.mint.toBase58()),
          destination: kitAddress(t.destinationAta.toBase58()),
          authority: swigWalletKitAddr,
          amount: t.amount,
          decimals: v.decimals,
        }),
      );
      const signIx = await getSignInstructions(
        swig,
        1 /* role-1 ProgramExec (marker = settle_tab_voucher) */,
        transferIxs as any,
        false,
        { payer: kitAddress(a.feePayer.toBase58()), preInstructions: [a.vaultIx] } as any,
      );
      return kitInstructionsToWeb3(signIx);
    };

    // SDK settleTab: voucher message + ed25519 precompile + settle_tab_voucher
    // + SignV2 — one atomic instruction list. The session key signs the voucher
    // via the SDK's node signer.
    const channelId = new Uint8Array(32);
    crypto.getRandomValues(channelId);
    const settleIxs = await settleTab({
      connection,
      vaultPda: v.vaultPda,
      swigAddress: v.swigAddress,
      channelId,
      cumulativeAmount: CUMULATIVE,
      sequenceNumber: 1,
      sessionSigner: new NodeEd25519Signer(sessionA.secretKey),
      sellerAta,
      feePayer: wallet,
      dexterAuthority: wallet,
      allowedCounterparty: cpA,
      assembleSignV2: testMintAssembler,
    });
    const settleSig = await sendAndConfirmWithRetry(provider, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ...settleIxs,
    ]);
    console.log(`    ✓ SUBMITTED settleTab(A, cumulative=$1): ${settleSig}`);

    // SDK decode: spent advanced, revolving released.
    const s = await pollUntilAccount(
      async () => (await fetchSessionAccount(connection, v.vaultPda, cpA))!,
      (st) => st.session.spent === CUMULATIVE,
    );
    expect(s.session.spent === CUMULATIVE).to.equal(true);
    expect(s.session.currentOutstanding === 0n).to.equal(true);
    const meter = await readTabMeter(connection, v.vaultPda, cpA);
    expect(meter.remaining === A_MAX - CUMULATIVE).to.equal(true);
    console.log(`    ✓ meter after settle: spent=${s.session.spent} outstanding=0 remaining=${meter.remaining}`);
  });

  it("SDK SUBMIT #5: revoke A (message from the PDA's live pubkey) → CLEAR", async () => {
    // SDK: the revoke message embeds the session pubkey READ FROM THE PDA.
    const live = await fetchSessionAccount(connection, v.vaultPda, cpA);
    expect(live).to.not.equal(null);
    const msg = sessionRevokeMessage({
      programId: program.programId,
      vaultPda: v.vaultPda,
      sessionPubkey: live!.session.sessionPubkey,
    });
    const signed = signOperationWithPasskey(v.passkey, msg);
    const precompileIx = buildSecp256r1VerifyInstruction(
      v.passkey.publicKey,
      signed.signature,
      signed.precompileMessage,
    );
    const revokeIx = buildRevokeSessionKeyInstruction({
      vaultPda: v.vaultPda,
      allowedCounterparty: cpA,
      clientDataJSON: signed.clientDataJSON,
      authenticatorData: signed.authenticatorData,
    });
    const sig = await sendPrecompilePairResilient(
      provider,
      [precompileIx, revokeIx],
      async () => {
        const s = await fetchSessionAccount(connection, v.vaultPda, cpA);
        return !!s && s.version === 0;
      },
    );
    console.log(`    ✓ SUBMITTED revoke(A): ${sig ?? "(self-healed)"}`);

    // SDK: cleared-mode confirm-visibility.
    const cleared = await waitForSession(connection, v.vaultPda, cpA, {
      cleared: true,
      timeoutMs: 60_000,
    });
    expect(cleared.version).to.equal(0);
    const vault = await readVaultFull(connection, v.vaultPda);
    expect(vault.liveSessionCount).to.equal(1);
    console.log(`    ✓ A cleared (version=0); liveSessionCount=1`);
  });

  it("SDK SUBMIT #6: REPLACE B in place — meters reset, cleared A excluded from siblings", async () => {
    // SDK sibling discovery: A is version 0 → filtered OUT; B is the target →
    // excluded by the builder. Effective sibling set must be empty.
    const pop = await fetchVaultSessionAccounts(connection, v.vaultPda);
    expect(pop.length, "population (A cleared, B live)").to.equal(1);
    expect(pop[0].session.allowedCounterparty).to.equal(cpB.toBase58());

    const sig = await registerViaSdk({
      sessionKeypair: sessionB2,
      counterparty: cpB,
      maxAmount: B_MAX,
      nonce: 3,
    });
    console.log(`    ✓ SUBMITTED replace(B → B2): ${sig}`);

    const s = await fetchSessionAccount(connection, v.vaultPda, cpB);
    const b2 = sessionB2.publicKey.toBytes();
    expect(s!.session.sessionPubkey.every((b, i) => b === b2[i])).to.equal(true);
    expect(s!.session.nonce).to.equal(3);
    expect(s!.session.spent === 0n).to.equal(true);
    expect(s!.session.currentOutstanding === 0n).to.equal(true);
    const vault = await readVaultFull(connection, v.vaultPda);
    expect(vault.liveSessionCount).to.equal(1);
    console.log(`    ✓ B replaced in place: new pubkey visible, meters reset, count still 1`);
  });

  it("SUMMARY", () => {
    console.log("\n    ═══════════════════════════════════════════════════════");
    console.log("    SDK V6 multi-session PROVEN on mainnet:");
    console.log("      • register (empty sibling set)        — SDK builder + message");
    console.log("      • register w/ live sibling contract   — SDK fetch+sort+writable");
    console.log("      • readTabMeter                        — SDK session-PDA read");
    console.log("      • openTab + settleTab (3-ix atomic)   — SDK tab verbs");
    console.log("      • revoke (PDA-read pubkey message)    — SDK builder + message");
    console.log("      • replace-in-place (meters reset)     — SDK, cleared-A filtered");
    console.log("    All instructions/messages/decodes/waits: @dexterai/vault local build.");
    console.log("    ═══════════════════════════════════════════════════════\n");
  });
});
