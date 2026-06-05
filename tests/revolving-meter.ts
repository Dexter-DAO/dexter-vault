import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { DexterVault } from "../target/types/dexter_vault";
import { expect } from "chai";

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
