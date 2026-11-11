import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeArchOf, type NativeArch } from "./nativeArch.ts"

// Builds the Windows drag-out addon (native/dragOut/win, crate filen-drag, its toolchain pinned in rust-toolchain.toml)
// per architecture and copies filen_drag.dll to build/native/win-<arch>/filen-drag.node, beside the staged sync addon,
// so electron-builder ships it and the loader finds it in development. Runs after scripts/stageNapi.ts, which clears
// those directories. cargo is skipped while the crate's build is newer than its sources, so a second package run
// (release-desktop packs Windows twice) only copies. Without cargo it warns and skips: drag-out then answers
// "unavailable" in development, and a Windows package fails in electron-builder's beforePack. A no-op off Windows.
//
// `--dev` builds this machine's architecture only, and nothing while the addon is newer than its sources.
//
//   node scripts/buildDragAddon.ts [--dev]

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const crateDir = path.join(packageDir, "native", "dragOut", "win")
const targetDir = path.join(crateDir, "target")
const ARCHS: NativeArch[] = ["x64", "arm64"]

export const DRAG_ADDON_FILE = "filen-drag.node"

export function dragAddonOutput(arch: NativeArch): string {
	return path.join(packageDir, "build", "native", `win-${arch}`, DRAG_ADDON_FILE)
}

export function windowsTriple(arch: NativeArch): string {
	return arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc"
}

// What cargo builds for `arch`.
export function dragAddonArtifact(arch: NativeArch): string {
	return path.join(targetDir, windowsTriple(arch), "release", "filen_drag.dll")
}

// Everything the build reads: the manifests, the toolchain pin, the build script and the sources.
export function dragAddonSources(): string[] {
	const src = path.join(crateDir, "src")

	return [
		...["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "build.rs"].map(file => path.join(crateDir, file)),
		...readdirSync(src)
			.filter(file => file.endsWith(".rs"))
			.map(file => path.join(src, file))
	]
}

// `mtime` is null for a missing file.
export function needsRebuild(output: string, sources: readonly string[], mtime: (file: string) => number | null): boolean {
	const built = mtime(output)

	return built === null || sources.some(source => (mtime(source) ?? Infinity) > built)
}

export interface DragAddonHost {
	platform: NodeJS.Platform
	arch: string
	// The exit status, or null when the command could not be started (not on PATH).
	run(command: string, args: readonly string[], cwd: string): number | null
	mtime(file: string): number | null
	copy(from: string, to: string): void
	archOf(file: string): NativeArch | null
	log(message: string): void
}

const host: DragAddonHost = {
	platform: process.platform,
	arch: process.arch,
	run: (command, args, cwd) => {
		const result = spawnSync(command, args, { cwd, stdio: "inherit" })

		return result.error === undefined ? result.status : null
	},
	mtime: file => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null,
	copy: (from, to) => {
		mkdirSync(path.dirname(to), { recursive: true })
		copyFileSync(from, to)
	},
	archOf: nativeArchOf,
	log: message => {
		console.log(message)
	}
}

export function buildDragAddon(options: { dev: boolean }, env: DragAddonHost = host): void {
	if (env.platform !== "win32") {
		env.log("buildDragAddon: not Windows; skipped")

		return
	}

	const sources = dragAddonSources()
	const archs = options.dev ? ARCHS.filter(arch => arch === env.arch) : ARCHS

	for (const arch of archs) {
		const output = dragAddonOutput(arch)
		const artifact = dragAddonArtifact(arch)

		if (options.dev && !needsRebuild(output, sources, env.mtime)) {
			continue
		}

		if (needsRebuild(artifact, sources, env.mtime)) {
			const status = env.run(
				"cargo",
				["build", "--release", "--locked", "--target", windowsTriple(arch), "--target-dir", targetDir],
				crateDir
			)

			if (status === null) {
				env.log("buildDragAddon: cargo not found; skipped (dragging out to Explorer is unavailable)")

				return
			}

			if (status !== 0) {
				throw new Error(`cargo build failed for ${DRAG_ADDON_FILE} (${arch})`)
			}
		}

		env.copy(artifact, output)

		const found = env.archOf(output)

		if (found !== arch) {
			throw new Error(`${output} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		env.log(`buildDragAddon: ${arch}`)
	}
}

if (import.meta.main) {
	buildDragAddon({ dev: process.argv.includes("--dev") })
}
