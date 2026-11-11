import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeArchOf, type NativeArch } from "./nativeArch.ts"

// Builds a Swift Node-API addon of native/<sourceDir> per architecture to build/native/mac-<arch>/<file>, beside the
// staged sync addon, so electron-builder ships it with it and the loader finds it in development. Runs after
// scripts/stageNapi.ts, which clears those directories. Every addon compiles native/shared (Node-API helpers and the
// module map) with its own sources, links against the Swift runtime its macOS floor ships, and resolves Node-API from
// the host process at load time. A no-op on other hosts.
//
// `dev` builds this machine's architecture only, and nothing while the addon is newer than its inputs.

export interface SwiftAddon {
	// The building script's name, for its log lines.
	name: string
	// The directory under native/ holding the addon's own sources.
	sourceDir: string
	module: string
	file: string
	macos: string
}

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const nativeDir = path.join(packageDir, "native")
const sharedDir = path.join(nativeDir, "shared")
const moduleMapDir = path.join(sharedDir, "NodeAPI")
const ARCHS: NativeArch[] = ["x64", "arm64"]
const TRIPLE_ARCH: Record<NativeArch, string> = { x64: "x86_64", arm64: "arm64" }

function swiftFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter(file => file.endsWith(".swift"))
		.map(file => path.join(dir, file))
}

export function swiftAddonOutput(file: string, arch: NativeArch): string {
	return path.join(packageDir, "build", "native", `mac-${arch}`, file)
}

export function swiftAddonSources(sourceDir: string): string[] {
	return [...swiftFiles(path.join(nativeDir, sourceDir)), ...swiftFiles(sharedDir)]
}

export function swiftAddonInputs(sourceDir: string): string[] {
	return [...swiftAddonSources(sourceDir), ...readdirSync(moduleMapDir).map(file => path.join(moduleMapDir, file))]
}

// `mtime` is null for a missing file.
export function isUpToDate(output: string, inputs: readonly string[], mtime: (file: string) => number | null): boolean {
	const built = mtime(output)

	return built !== null && inputs.every(input => (mtime(input) ?? Infinity) <= built)
}

function mtimeOf(file: string): number | null {
	return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null
}

export function buildSwiftAddon(addon: SwiftAddon, options: { dev: boolean }): void {
	if (process.platform !== "darwin") {
		console.log(`${addon.name}: not macOS; skipped`)

		return
	}

	const headers = path.join(path.dirname(createRequire(import.meta.url).resolve("node-api-headers/package.json")), "include")
	const sources = swiftAddonSources(addon.sourceDir)
	const inputs = swiftAddonInputs(addon.sourceDir)
	const archs = options.dev ? ARCHS.filter(arch => arch === process.arch) : ARCHS

	for (const arch of archs) {
		const output = swiftAddonOutput(addon.file, arch)

		if (options.dev && isUpToDate(output, inputs, mtimeOf)) {
			continue
		}

		mkdirSync(path.dirname(output), { recursive: true })

		const result = spawnSync(
			"xcrun",
			[
				"swiftc",
				"-emit-library",
				"-target",
				`${TRIPLE_ARCH[arch]}-apple-macos${addon.macos}`,
				"-O",
				"-whole-module-optimization",
				"-swift-version",
				"6",
				"-module-name",
				addon.module,
				"-I",
				moduleMapDir,
				"-Xcc",
				`-I${headers}`,
				"-Xlinker",
				"-undefined",
				"-Xlinker",
				"dynamic_lookup",
				// The registration hook is the only entry point; everything else is dead-stripped and its symbols dropped.
				"-Xlinker",
				"-exported_symbol",
				"-Xlinker",
				"_napi_register_module_v1",
				"-Xlinker",
				"-dead_strip",
				"-Xlinker",
				"-x",
				"-o",
				output,
				...sources
			],
			{ stdio: "inherit" }
		)

		if (result.status !== 0) {
			throw new Error(`swiftc failed for ${addon.file} (${arch})`)
		}

		const found = nativeArchOf(output)

		if (found !== arch) {
			throw new Error(`${output} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		console.log(`${addon.name}: ${arch}`)
	}
}
