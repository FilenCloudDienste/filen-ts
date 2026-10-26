import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

// The sync addon and rclone staged per arch, the production bundle (which bakes in the Linux rclone digests), then
// electron-builder for the host (extra CLI args such as `--mac dir` are passed through).
// Uploading is the release workflow's job, so nothing is published from here.
process.env["NODE_ENV"] = "production"

// Loaded first so a missing web build fails before bundling.
const { macMinimum } = await import("../electron-builder.ts")

await import("./stageNapi.ts")
await (await import("./stageRclone.ts")).stageRclone()
await import("./build.ts")

const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js")
// `pnpm run dist -- --mac dir` forwards the "--"; electron-builder would treat everything after it as positional.
const args = process.argv.slice(2).filter(arg => arg !== "--")
const result = spawnSync(process.execPath, [cli, "--publish", "never", ...args], { stdio: "inherit" })

if (result.status !== 0) {
	process.exit(result.status ?? 1)
}

// electron-builder never writes minimumSystemVersion; without it older macOS installs would download a build they
// cannot run.
const macFeed = path.join("release", "latest-mac.yml")

if (existsSync(macFeed)) {
	const feed = readFileSync(macFeed, "utf8")

	if (!/^minimumSystemVersion:/m.test(feed)) {
		writeFileSync(macFeed, `minimumSystemVersion: ${macMinimum.darwin}\n${feed}`)
	}
}
