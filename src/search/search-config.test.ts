import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadSearchConfig } from "./search-config.js";

describe("loadSearchConfig – SEARCH_MODE", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.SEARCH_MODE;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_MODE;
    else process.env.SEARCH_MODE = original;
  });

  it("defaults to auto when SEARCH_MODE is unset", () => {
    delete process.env.SEARCH_MODE;
    assert.equal(loadSearchConfig().mode, "auto");
  });

  it("returns human when SEARCH_MODE=human", () => {
    process.env.SEARCH_MODE = "human";
    assert.equal(loadSearchConfig().mode, "human");
  });

  it("defaults to auto for unknown value", () => {
    process.env.SEARCH_MODE = "invalid";
    assert.equal(loadSearchConfig().mode, "auto");
  });
});
