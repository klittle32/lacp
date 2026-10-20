// Cross-platform build: clean dist, compile, mark the CLI entry executable.
// Replaces `rm -rf dist && tsc && chmod +x`, which fail under npm's cmd.exe shell on Windows.
import { execFileSync } from "node:child_process"
import { chmodSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

rmSync(join(root, "dist"), { recursive: true, force: true })

const tsc = join(root, "node_modules", "typescript", "bin", "tsc")
execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" })

if (process.platform !== "win32") chmodSync(join(root, "dist", "main.js"), 0o755)
