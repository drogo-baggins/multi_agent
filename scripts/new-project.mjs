import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: "inherit" });
  if (result.error) {
    return { ok: false, error: result.error };
  }

  return { ok: result.status === 0, status: result.status };
}

if (process.platform === "win32") {
  const windowsCommands = [
    ["pwsh", ["-File", "scripts/new-project.ps1"]],
    ["powershell.exe", ["-File", "scripts/new-project.ps1"]]
  ];

  for (const [command, args] of windowsCommands) {
    const result = run(command, args);
    if (result.ok) {
      process.exit(0);
    }

    if (result.error?.code === "ENOENT") {
      continue;
    }

    process.exit(typeof result.status === "number" ? result.status : 1);
  }

  console.error("Neither pwsh nor powershell.exe is available.");
  process.exit(1);
}

const result = run("bash", ["scripts/new-project.sh"]);
process.exit(typeof result.status === "number" ? result.status : 1);