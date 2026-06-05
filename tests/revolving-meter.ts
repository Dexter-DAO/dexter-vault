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
} from "./helpers/secp256r1";

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
 * Provision a fresh vault whose dexterAuthority is the provider wallet, then
 * register a session that endorses both maxAmount and maxRevolvingCapacity via
 * the V2 188-byte passkey ceremony. Returns the vault PDA.
 */
async function registerSessionWithCapacity(
  program: Program<DexterVault>,
  provider: anchor.AnchorProvider,
  opts: { maxAmount: number; maxRevolvingCapacity: number }
): Promise<{ vaultPda: PublicKey }> {
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
      payer: provider.wallet.publicKey,
      dexterAuthority: provider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const sessionPubkey = Keypair.generate().publicKey.toBytes();
  const allowedCounterparty = Keypair.generate().publicKey;
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce = 1;
  const maxAmount = BigInt(opts.maxAmount);
  const maxRevolvingCapacity = BigInt(opts.maxRevolvingCapacity);

  const msg = sessionRegisterMessageV2({
    programId: program.programId,
    vaultPda,
    sessionPubkey,
    maxAmount,
    expiresAt,
    allowedCounterparty,
    nonce,
    maxRevolvingCapacity,
  });
  const signed = signOperationWithPasskey(passkey, msg);
  const precompileIx = buildSecp256r1VerifyInstruction(
    passkey.publicKey,
    signed.signature,
    signed.precompileMessage
  );
  const vaultIx = await program.methods
    .registerSessionKey({
      sessionPubkey: Array.from(sessionPubkey),
      maxAmount: new anchor.BN(maxAmount.toString()),
      expiresAt: new anchor.BN(expiresAt.toString()),
      allowedCounterparty,
      nonce,
      maxRevolvingCapacity: new anchor.BN(maxRevolvingCapacity.toString()),
      clientDataJson: Buffer.from(signed.clientDataJSON),
      authenticatorData: Buffer.from(signed.authenticatorData),
    })
    .accountsPartial({ vault: vaultPda, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  const tx = new Transaction().add(precompileIx, vaultIx);
  await provider.sendAndConfirm(tx);
  return { vaultPda };
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
