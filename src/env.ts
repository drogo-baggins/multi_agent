import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load environment variables from a `.env` file into `process.env`.
 *
 * - Lines starting with `#` are treated as comments.
 * - Empty lines are skipped.
 * - Supports `KEY=VALUE`, `KEY="VALUE"`, and `KEY='VALUE'`.
 * - Existing env vars are NOT overwritten (real environment takes precedence).
 * - If the file does not exist, silently does nothing.
 */
export function loadEnvFile(filePath?: string): void {
  const target = filePath ?? resolve(process.cwd(), ".env");

  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch {
    return;
  }

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key.length > 0 && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
