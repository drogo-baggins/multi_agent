import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./env.js";

const tmpDir = join(import.meta.dirname, "..", ".tmp-env-test");

function writeTmpEnv(content: string): string {
  mkdirSync(tmpDir, { recursive: true });
  const filePath = join(tmpDir, ".env");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("loadEnvFile", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const injectedKeys: string[] = [];

  function trackKey(key: string): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    injectedKeys.push(key);
  }

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    for (const key of injectedKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    injectedKeys.length = 0;

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("parses KEY=VALUE pairs", () => {
    trackKey("TEST_ENV_SIMPLE");
    const filePath = writeTmpEnv("TEST_ENV_SIMPLE=hello");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_SIMPLE"], "hello");
  });

  it("strips double quotes from values", () => {
    trackKey("TEST_ENV_DQUOTE");
    const filePath = writeTmpEnv('TEST_ENV_DQUOTE="quoted value"');
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_DQUOTE"], "quoted value");
  });

  it("strips single quotes from values", () => {
    trackKey("TEST_ENV_SQUOTE");
    const filePath = writeTmpEnv("TEST_ENV_SQUOTE='single quoted'");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_SQUOTE"], "single quoted");
  });

  it("skips comment lines", () => {
    trackKey("TEST_ENV_AFTER_COMMENT");
    const filePath = writeTmpEnv("# This is a comment\nTEST_ENV_AFTER_COMMENT=present");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_AFTER_COMMENT"], "present");
  });

  it("skips empty lines", () => {
    trackKey("TEST_ENV_EMPTY_LINES");
    const filePath = writeTmpEnv("\n\nTEST_ENV_EMPTY_LINES=found\n\n");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_EMPTY_LINES"], "found");
  });

  it("does not overwrite existing env vars", () => {
    trackKey("TEST_ENV_EXISTING");
    process.env["TEST_ENV_EXISTING"] = "original";
    const filePath = writeTmpEnv("TEST_ENV_EXISTING=overwritten");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_EXISTING"], "original");
  });

  it("silently does nothing when file does not exist", () => {
    const before = { ...process.env };
    loadEnvFile(join(tmpDir, "nonexistent.env"));
    assert.deepEqual(Object.keys(process.env).length, Object.keys(before).length);
  });

  it("handles values containing equals signs", () => {
    trackKey("TEST_ENV_EQUALS");
    const filePath = writeTmpEnv("TEST_ENV_EQUALS=abc=def=ghi");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_EQUALS"], "abc=def=ghi");
  });

  it("trims whitespace around keys and values", () => {
    trackKey("TEST_ENV_TRIM");
    const filePath = writeTmpEnv("  TEST_ENV_TRIM  =  spaced  ");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_TRIM"], "spaced");
  });

  it("skips lines without equals sign", () => {
    trackKey("TEST_ENV_VALID");
    const filePath = writeTmpEnv("INVALID_LINE\nTEST_ENV_VALID=ok");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_VALID"], "ok");
  });

  it("handles empty values", () => {
    trackKey("TEST_ENV_EMPTY_VAL");
    const filePath = writeTmpEnv("TEST_ENV_EMPTY_VAL=");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_EMPTY_VAL"], "");
  });

  it("handles CRLF line endings", () => {
    trackKey("TEST_ENV_CRLF");
    const filePath = writeTmpEnv("TEST_ENV_CRLF=windows\r\n");
    loadEnvFile(filePath);
    assert.equal(process.env["TEST_ENV_CRLF"], "windows");
  });
});
