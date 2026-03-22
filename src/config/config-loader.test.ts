import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { initializeAgentConfig, loadAgentConfig } from "./index.js";

describe("config loader", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-config-"));
  });

  after(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("loads files in required assembly order", async () => {
    const agentDir = join(tempRoot, "ordered-agent");
    const skillsDir = join(agentDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(agentDir, "agent.md"), "agent-section");
    await writeFile(join(agentDir, "system.md"), "system-section");
    await writeFile(join(skillsDir, "a.md"), "skill-a");
    await writeFile(join(skillsDir, "b.md"), "skill-b");
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "append-section");

    const result = await loadAgentConfig(agentDir);

    const chunks = result.split("\n\n");
    assert.equal(chunks[0], "agent-section");
    assert.equal(chunks[1], "system-section");
    assert.equal(chunks[chunks.length - 1], "append-section");
    assert.equal(chunks.length, 5);
    assert.deepEqual(chunks.slice(2, 4), ["skill-a", "skill-b"]);
  });

  it("skips missing files without throwing", async () => {
    const agentDir = join(tempRoot, "partial-agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "system.md"), "only-system");

    const result = await loadAgentConfig(agentDir);

    assert.equal(result, "only-system");
  });

  it("loads only requested skills when skills are specified", async () => {
    const agentDir = join(tempRoot, "selected-skills-agent");
    const skillsDir = join(agentDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(agentDir, "agent.md"), "agent");
    await writeFile(join(skillsDir, "alpha.md"), "alpha");
    await writeFile(join(skillsDir, "beta.md"), "beta");
    await writeFile(join(skillsDir, "gamma.md"), "gamma");

    const result = await loadAgentConfig(agentDir, ["gamma", "alpha"]);

    assert.equal(result, ["agent", "gamma", "alpha"].join("\n\n"));
  });

  it("returns empty string for empty directories", async () => {
    const agentDir = join(tempRoot, "empty-agent");
    await mkdir(agentDir, { recursive: true });

    const result = await loadAgentConfig(agentDir);

    assert.equal(result, "");
  });
});

describe("config initializer", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-init-"));
  });

  after(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates required directory and file structure", async () => {
    const agentDir = join(tempRoot, "new-agent");
    await initializeAgentConfig(agentDir, "new-agent");

    await access(join(agentDir, "agent.md"));
    await access(join(agentDir, "system.md"));
    await access(join(agentDir, "APPEND_SYSTEM.md"));
    await access(join(agentDir, "skills"));
    await access(join(agentDir, "changelog.md"));
    await access(join(agentDir, "backups"));
  });
});
