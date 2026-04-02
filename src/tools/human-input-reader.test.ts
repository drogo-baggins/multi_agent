import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTerminator } from "./human-input-reader.js";

describe("human-input-reader – parseTerminator", () => {
  it("detects END terminator", () => {
    assert.equal(parseTerminator("END"), "end");
  });

  it("detects SKIP terminator", () => {
    assert.equal(parseTerminator("SKIP"), "skip");
  });

  it("returns null for normal input", () => {
    assert.equal(parseTerminator("hello world"), null);
  });

  it("is case insensitive", () => {
    assert.equal(parseTerminator("end"), "end");
    assert.equal(parseTerminator("skip"), "skip");
  });
});
