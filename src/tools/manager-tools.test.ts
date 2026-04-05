import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createEvaluateWorkProductTool,
  createReadChangelogTool,
  createReadTaskPlanTool,
  createReadWorkProductTool,
  createReadWorkerConfigTool,
  createUpdateTaskPlanTool,
  createUpdateWorkerConfigTool
} from "./manager-tools.js";

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first?.text ?? "";
}

describe("manager tools", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-manager-tools-"));
  });

  after(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("read_worker_config reads and formats all config files", async () => {
    const workerConfigDir = join(tempRoot, "worker-config-read");
    const skillsDir = join(workerConfigDir, "skills");
    await mkdir(skillsDir, { recursive: true });
    await writeFile(join(workerConfigDir, "agent.md"), "worker-agent-config");
    await writeFile(join(workerConfigDir, "system.md"), "worker-system-config");
    await writeFile(join(workerConfigDir, "APPEND_SYSTEM.md"), "worker-append-config");
    await writeFile(join(skillsDir, "alpha.md"), "skill-alpha");
    await writeFile(join(skillsDir, "beta.md"), "skill-beta");

    const tool = createReadWorkerConfigTool(workerConfigDir);
    const result = await tool.execute("call-1", {});
    const text = getText(result);

    assert.match(text, /## agent\.md/);
    assert.match(text, /worker-agent-config/);
    assert.match(text, /## system\.md/);
    assert.match(text, /worker-system-config/);
    assert.match(text, /## APPEND_SYSTEM\.md/);
    assert.match(text, /worker-append-config/);
    assert.match(text, /## skills\/alpha\.md/);
    assert.match(text, /skill-alpha/);
    assert.match(text, /## skills\/beta\.md/);
    assert.match(text, /skill-beta/);
  });

  it("read_work_product lists files and reads specific file", async () => {
    const sandboxDir = join(tempRoot, "sandbox-read-work");
    const outputDir = join(sandboxDir, "output");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "report-a.md"), "report A content");
    await writeFile(join(outputDir, "report-b.txt"), "report B content");

    const tool = createReadWorkProductTool(sandboxDir);

    const listResult = await tool.execute("call-2", {});
    const listText = getText(listResult);
    assert.match(listText, /report-a\.md/);
    assert.match(listText, /report-b\.txt/);

    const readResult = await tool.execute("call-3", { filename: "report-a.md" });
    const readText = getText(readResult);
    assert.match(readText, /report A content/);
  });

  it("update_worker_config creates backup writes file and appends changelog", async () => {
    const workerConfigDir = join(tempRoot, "worker-config-update");
    await mkdir(workerConfigDir, { recursive: true });
    const appendPath = join(workerConfigDir, "APPEND_SYSTEM.md");
    const changelogPath = join(workerConfigDir, "changelog.md");
    await writeFile(appendPath, "old append content");

    const tool = createUpdateWorkerConfigTool(workerConfigDir);
    await tool.execute("call-4", {
      content: "new append content",
      reason: "improve manager guidance",
      hypothesis: "clearer guidance improves output quality",
      expectedEffect: "higher quality reports",
      llmModel: "claude-sonnet-4"
    });

    const newAppend = await readFile(appendPath, "utf-8");
    assert.equal(newAppend, "new append content");

    const backupDir = join(workerConfigDir, "backups");
    const backupFiles = await readdir(backupDir);
    assert.equal(backupFiles.length, 1);
    assert.match(backupFiles[0] ?? "", /^APPEND_SYSTEM\.\d+\.md$/);
    const backupContent = await readFile(join(backupDir, backupFiles[0] ?? ""), "utf-8");
    assert.equal(backupContent, "old append content");

    const changelog = await readFile(changelogPath, "utf-8");
    assert.match(changelog, /## \[/);
    assert.match(changelog, /- target_file: APPEND_SYSTEM\.md/);
    assert.match(changelog, /- hypothesis: clearer guidance improves output quality/);
    assert.match(changelog, /- change_content: /);
    assert.match(changelog, /- reason: improve manager guidance/);
    assert.match(changelog, /- expected_effect: higher quality reports/);
    assert.match(changelog, /- llm_model: claude-sonnet-4/);
  });

  it("read_changelog returns changelog content", async () => {
    const workerConfigDir = join(tempRoot, "worker-config-changelog");
    await mkdir(workerConfigDir, { recursive: true });
    await writeFile(join(workerConfigDir, "changelog.md"), "changelog body");

    const tool = createReadChangelogTool(workerConfigDir);
    const result = await tool.execute("call-5", {});
    const text = getText(result);

    assert.equal(text, "changelog body");
  });

  it("read_task_plan returns missing message when task-plan is absent", async () => {
    const taskPlanPath = join(tempRoot, "workspace", "task-plan.md");
    await mkdir(join(tempRoot, "workspace"), { recursive: true });

    const tool = createReadTaskPlanTool(taskPlanPath);
    const result = await tool.execute("call-7", {});
    const text = getText(result);

    assert.equal(text, "タスク計画はまだ作成されていません。");
  });

  it("update_task_plan updates status and appends a note", async () => {
    const taskPlanPath = join(tempRoot, "workspace-update-task-plan", "task-plan.md");
    await mkdir(join(tempRoot, "workspace-update-task-plan"), { recursive: true });
    const planPath = taskPlanPath;
    await writeFile(
      planPath,
      [
        "# タスク計画",
        "",
        "## 成果物構造",
        "- TODO [L2-001] Collect sources",
        "  - スコープ: Official docs",
        "",
        "## ユーザー指示履歴",
        "- なし"
      ].join("\n")
    );

    const tool = createUpdateTaskPlanTool(taskPlanPath);
    const result = await tool.execute("call-8", {
      operation: "update-work-unit",
      workUnitGoal: "Collect sources",
      newStatus: "DOING",
      note: "L3-001 Search official references"
    });

    const text = getText(result);
    const updated = await readFile(planPath, "utf-8");

    assert.equal(text, "Updated task-plan.md: Collect sources → DOING");
    assert.match(updated, /- DOING \[L2-001\] Collect sources/);
    assert.match(updated, /Search official references/);
  });

  it("update_task_plan can add and update explicit L3 entries", async () => {
    const taskPlanPath = join(tempRoot, "workspace-l3", "task-plan.md");
    await mkdir(join(tempRoot, "workspace-l3"), { recursive: true });
    await writeFile(
      taskPlanPath,
      [
        "# タスク計画",
        "",
        "## 成果物構造",
        "- TODO [L2-001] Collect sources",
        "  - スコープ: Official docs",
        "",
        "## ユーザー指示履歴",
        "- なし"
      ].join("\n")
    );

    const tool = createUpdateTaskPlanTool(taskPlanPath);
    const addResult = await tool.execute("call-9", {
      operation: "add-l3",
      workUnitGoal: "Collect sources",
      newStatus: "DOING",
      l3EntryId: "L3-001",
      l3Description: "Search official references"
    });

    assert.equal(getText(addResult), "Updated task-plan.md: Collect sources → DOING");

    const updateResult = await tool.execute("call-10", {
      operation: "update-l3",
      newStatus: "DONE",
      l3EntryId: "L3-001",
      note: "Validated against official docs"
    });

    assert.equal(getText(updateResult), "Updated task-plan.md: L3-001 → DONE");

    const updated = await readFile(taskPlanPath, "utf-8");
    assert.match(updated, /- DONE \[L3-001\] Search official references/);
    assert.match(updated, /Validated against official docs/);
  });

  it("update_worker_config rejects when write fails due to read-only file", async () => {
    const workerConfigDir = join(tempRoot, "worker-config-readonly");
    await mkdir(workerConfigDir, { recursive: true });
    const appendPath = join(workerConfigDir, "APPEND_SYSTEM.md");
    await writeFile(appendPath, "old content");
    await chmod(appendPath, 0o444);

    const tool = createUpdateWorkerConfigTool(workerConfigDir);
    try {
      await assert.rejects(
        () =>
          tool.execute("call-fail", {
            content: "new content",
            reason: "test",
            hypothesis: "test",
            expectedEffect: "test",
            llmModel: "claude-sonnet-4"
          }),
        (err: unknown) => err instanceof Error
      );
    } finally {
      await chmod(appendPath, 0o644);
    }
  });

  it("evaluate_work_product returns content with evaluation framework", async () => {
    const sandboxDir = join(tempRoot, "sandbox-evaluate");
    const outputDir = join(sandboxDir, "output");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "evaluation-target.md"), "target report body");

    const tool = createEvaluateWorkProductTool(sandboxDir);
    const result = await tool.execute("call-6", { filename: "evaluation-target.md" });
    const text = getText(result);

    assert.match(text, /target report body/);
    assert.match(text, /coverage/i);
    assert.match(text, /accuracy/i);
    assert.match(text, /structure/i);
    assert.match(text, /citations/i);
    assert.match(text, /hypothesis/i);
    assert.match(text, /verification/i);
  });
});
