import * as readline from "node:readline";

export function parseTerminator(line: string): "end" | "skip" | null {
  const trimmed = line.trim().toLowerCase();
  if (trimmed === "end") return "end";
  if (trimmed === "skip") return "skip";
  return null;
}

export interface ReadMultilineOptions {
  timeoutMs?: number;
}

export async function readMultilineInput(
  prompt: string,
  options: ReadMultilineOptions = {}
): Promise<string | null> {
  return new Promise(resolve => {
    const lines: string[] = [];
    let timer: NodeJS.Timeout | undefined;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    process.stdout.write(prompt + "\n");
    process.stdout.write('（入力後、単独行に "END" と入力するか Ctrl+D で確定。"SKIP" でスキップ）\n');

    function finish(result: string | null): void {
      if (timer !== undefined) clearTimeout(timer);
      rl.close();
      resolve(result);
    }

    rl.on("line", (line: string) => {
      const cmd = parseTerminator(line);
      if (cmd === "skip") {
        finish(null);
        return;
      }
      if (cmd === "end") {
        finish(lines.join("\n"));
        return;
      }
      lines.push(line);
    });

    rl.on("close", () => {
      finish(lines.length > 0 ? lines.join("\n") : null);
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        process.stdout.write("\n[human mode] タイムアウトしました。スキップします。\n");
        finish(null);
      }, options.timeoutMs);
    }
  });
}
