import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertWithinSandbox } from "./sandboxed-tools.js";

describe("sandboxed-tools – assertWithinSandbox", () => {
  const sandbox = join(tmpdir(), "pi-agent-test", "workspace");

  it("allows relative paths", () => {
    assert.doesNotThrow(() => assertWithinSandbox("output/report.md", sandbox));
    assert.doesNotThrow(() => assertWithinSandbox("output/subtask-1.md", sandbox));
  });

  it("allows absolute paths inside sandbox", () => {
    assert.doesNotThrow(() =>
      assertWithinSandbox(join(sandbox, "output", "report.md"), sandbox)
    );
  });

  it("allows sandbox root itself", () => {
    assert.doesNotThrow(() => assertWithinSandbox(sandbox, sandbox));
  });

  it("blocks absolute paths outside sandbox", () => {
    const outside = join(tmpdir(), "pi-agent-test", "agents", "worker", "system.md");
    assert.throws(() => assertWithinSandbox(outside, sandbox), /Access denied/);
  });

  it("blocks absolute paths to project root output dir", () => {
    const outside = join(tmpdir(), "pi-agent-test", "output", "report.md");
    assert.throws(() => assertWithinSandbox(outside, sandbox), /Access denied/);
  });

  it("blocks path traversal attempts", () => {
    const traversal = join(sandbox, "..", "src", "index.ts");
    assert.throws(() => assertWithinSandbox(traversal, sandbox), /Access denied/);
  });
});
