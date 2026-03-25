#!/usr/bin/env tsx
import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function parseName(args: string[]): string {
  const idx = args.indexOf("--name");
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1].trim();
  }
  return "";
}

function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

function buildArchiveDirName(timestamp: string, name: string): string {
  return name ? `${timestamp}_${name}` : timestamp;
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
  const exists = await access(src).then(() => true).catch(() => false);
  if (!exists) return false;
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  return true;
}

interface LoopState {
  task?: string;
  currentIteration?: number;
  results?: Array<{ evaluation?: { qualityScore?: number } }>;
  status?: string;
}

async function readLoopState(workspaceDir: string): Promise<LoopState | null> {
  const candidates = [
    join(workspaceDir, "loop-state.json"),
    join(workspaceDir, "logs", "loop-state.json")
  ];
  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as LoopState;
    } catch (_e) {
      void _e;
    }
  }
  return null;
}

function extractFinalScore(state: LoopState): number | undefined {
  if (!state.results || state.results.length === 0) return undefined;
  return state.results[state.results.length - 1]?.evaluation?.qualityScore;
}

interface ArchiveMeta {
  name: string;
  archivedAt: string;
  task?: string;
  finalScore?: number;
  totalIterations?: number;
  loopStatus?: string;
}

function buildMeta(name: string, now: Date, loopState: LoopState | null): ArchiveMeta {
  const meta: ArchiveMeta = { name, archivedAt: now.toISOString() };
  if (loopState) {
    if (loopState.task) meta.task = loopState.task;
    if (loopState.currentIteration !== undefined) meta.totalIterations = loopState.currentIteration;
    const score = extractFinalScore(loopState);
    if (score !== undefined) meta.finalScore = score;
    if (loopState.status) meta.loopStatus = loopState.status;
  }
  return meta;
}

async function main(): Promise<void> {
  const name = parseName(process.argv.slice(2));
  const now = new Date();
  const archiveDirName = buildArchiveDirName(formatTimestamp(now), name);
  const archiveRoot = join(ROOT, "archives", archiveDirName);
  const workspaceDir = join(ROOT, "workspace");
  const agentsDir = join(ROOT, "agents");

  const archiveDirAlreadyExists = await access(archiveRoot).then(() => true).catch(() => false);
  if (archiveDirAlreadyExists) {
    console.error(`Error: Archive directory already exists: archives/${archiveDirName}`);
    process.exit(1);
  }

  await mkdir(archiveRoot, { recursive: true });
  console.log(`Archiving to: archives/${archiveDirName}`);

  const outputCopied = await copyIfExists(join(workspaceDir, "output"), join(archiveRoot, "output"));
  console.log(`  output/          ${outputCopied ? "✓" : "— (empty, skipped)"}`);

  const logsCopied = await copyIfExists(join(workspaceDir, "logs"), join(archiveRoot, "logs"));
  console.log(`  logs/            ${logsCopied ? "✓" : "— (empty, skipped)"}`);

  const appendCopied = await copyIfExists(
    join(agentsDir, "worker", "APPEND_SYSTEM.md"),
    join(archiveRoot, "agents", "worker", "APPEND_SYSTEM.md")
  );
  console.log(`  APPEND_SYSTEM.md ${appendCopied ? "✓" : "— (missing, skipped)"}`);

  const changelogCopied = await copyIfExists(
    join(agentsDir, "worker", "changelog.md"),
    join(archiveRoot, "agents", "worker", "changelog.md")
  );
  console.log(`  changelog.md     ${changelogCopied ? "✓" : "— (missing, skipped)"}`);

  const loopStateCopied = await copyIfExists(
    join(workspaceDir, "loop-state.json"),
    join(archiveRoot, "loop-state.json")
  );
  if (loopStateCopied) console.log(`  loop-state.json  ✓`);

  const loopState = await readLoopState(workspaceDir);
  const meta = buildMeta(name, now, loopState);
  await writeFile(join(archiveRoot, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  console.log(`  meta.json        ✓`);

  console.log(`\nDone. Archive saved to: archives/${archiveDirName}/`);
  if (meta.task) console.log(`  Task: ${meta.task}`);
  if (meta.finalScore !== undefined) console.log(`  Final score: ${meta.finalScore}/100`);
  if (meta.totalIterations !== undefined) console.log(`  Iterations: ${meta.totalIterations}`);
}

main().catch((err: unknown) => {
  console.error("Archive failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
