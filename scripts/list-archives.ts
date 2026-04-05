#!/usr/bin/env tsx
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARCHIVES_DIR = join(ROOT, "archives");

interface ArchiveMeta {
  name: string;
  archivedAt: string;
  task?: string;
  finalScore?: number;
  totalIterations?: number;
  loopStatus?: string;
}

interface ArchiveRow {
  dirName: string;
  meta: ArchiveMeta;
}

function formatDateTime(archivedAt: string): string {
  const date = new Date(archivedAt);
  if (Number.isNaN(date.getTime())) {
    return archivedAt;
  }
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function displayOrDash(value: string | number | undefined): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  return String(value);
}

async function loadArchiveRows(): Promise<ArchiveRow[]> {
  const entries = await readdir(ARCHIVES_DIR, { withFileTypes: true }).catch(() => []);
  const rows: ArchiveRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dirName = entry.name;
    const metaPath = join(ARCHIVES_DIR, dirName, "meta.json");
    try {
      const raw = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(raw) as ArchiveMeta;
      if (!meta || typeof meta.archivedAt !== "string") {
        continue;
      }
      rows.push({ dirName, meta });
    } catch {
      continue;
    }
  }

  rows.sort((left, right) => new Date(right.meta.archivedAt).getTime() - new Date(left.meta.archivedAt).getTime());
  return rows;
}

async function main(): Promise<void> {
  const rows = await loadArchiveRows();
  if (rows.length === 0) {
    console.log("アーカイブはまだありません");
    return;
  }

  const tableRows = rows.map((row, index) => ({
    no: String(index + 1),
    date: formatDateTime(row.meta.archivedAt),
    name: row.meta.name ? row.meta.name : "(名前なし)",
    task: row.meta.task ? row.meta.task : "-",
    score: row.meta.finalScore !== undefined ? `${row.meta.finalScore}/100` : "-",
    iterations: row.meta.totalIterations !== undefined ? String(row.meta.totalIterations) : "-"
  }));

  const headers = {
    no: "No.",
    date: "日時",
    name: "名前",
    task: "タスク",
    score: "スコア",
    iterations: "イテレーション"
  };

  const widths = {
    no: Math.max(headers.no.length, ...tableRows.map((row) => row.no.length)),
    date: Math.max(headers.date.length, ...tableRows.map((row) => row.date.length)),
    name: Math.max(headers.name.length, ...tableRows.map((row) => row.name.length)),
    task: Math.max(headers.task.length, ...tableRows.map((row) => row.task.length)),
    score: Math.max(headers.score.length, ...tableRows.map((row) => row.score.length)),
    iterations: Math.max(headers.iterations.length, ...tableRows.map((row) => row.iterations.length))
  };

  const line = ["-".repeat(widths.no), "-".repeat(widths.date), "-".repeat(widths.name), "-".repeat(widths.task), "-".repeat(widths.score), "-".repeat(widths.iterations)].join("|");

  console.log("=== 過去の調査アーカイブ ===\n");
  console.log(
    `${headers.no.padStart(widths.no)} | ${headers.date.padEnd(widths.date)} | ${headers.name.padEnd(widths.name)} | ${headers.task.padEnd(widths.task)} | ${headers.score.padEnd(widths.score)} | ${headers.iterations.padEnd(widths.iterations)}`
  );
  console.log(line);

  for (const row of tableRows) {
    console.log(
      `${row.no.padStart(widths.no)} | ${row.date.padEnd(widths.date)} | ${row.name.padEnd(widths.name)} | ${row.task.padEnd(widths.task)} | ${row.score.padEnd(widths.score)} | ${row.iterations.padEnd(widths.iterations)}`
    );
  }

  console.log(`\n合計: ${rows.length}件`);
}

main().catch((err: unknown) => {
  console.error("Archive listing failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});