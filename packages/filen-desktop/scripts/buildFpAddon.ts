import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeArchOf, type NativeArch } from "./nativeArch.ts"

// Builds the File Provider addon (native/fileProvider, Swift) per architecture to build/native/mac-<arch>/filen-fp.node,
// beside the staged sync addon, so electron-builder ships it with it and the loader finds it in development. Runs after
// scripts/stageNapi.ts, which clears those directories. It links against the Swift runtime macOS 14 ships, and resolves
// Node-API from the host process at load time. A no-op on other hosts.
//
// `--dev` builds this machine's architecture only, and nothing while the addon is newer than its sources.
//
//   node scripts/buildFpAddon.ts [--dev]

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const sourceDir = path.join(packageDir, "native", "fileProvider")
const moduleMapDir = path.join(sourceDir, "NodeAPI")
const ARCHS: NativeArch[] = ["x64", "arm64"]
const TRIPLE_ARCH: Record<NativeArch, string> = { x64: "x86_64", arm64: "arm64" }

export function buildFpAddon(options: { dev: boolean }): void {
	if (process.platform !== "darwin") {
		console.log("buildFpAddon: not macOS; skipped")

		return
	}

	const headers = path.join(path.dirname(createRequire(import.meta.url).resolve("node-api-headers/package.json")), "include")
	const sources = readdirSync(sourceDir)
		.filter(file => file.endsWith(".swift"))
		.map(file => path.join(sourceDir, file))
	const inputs = [...sources, ...readdirSync(moduleMapDir).map(file => path.join(moduleMapDir, file))]
	const newestInput = Math.max(...inputs.map(file => statSync(file).mtimeMs))
	const archs = options.dev ? ARCHS.filter(arch => arch === process.arch) : ARCHS

	for (const arch of archs) {
		const outDir = path.join(packageDir, "build", "native", `mac-${arch}`)
		const output = path.join(outDir, "filen-fp.node")

		if (options.dev && existsSync(output) && statSync(output).mtimeMs >= newestInput) {
			continue
		}

		mkdirSync(outDir, { recursive: true })

		const result = spawnSync(
			"xcrun",
			[
				"swiftc",
				"-emit-library",
				"-target",
				`${TRIPLE_ARCH[arch]}-apple-macos14.0`,
				"-O",
				"-whole-module-optimization",
				"-swift-version",
				"6",
				"-module-name",
				"FilenFileProvider",
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
			throw new Error(`swiftc failed for ${arch}`)
		}

		const found = nativeArchOf(output)

		if (found !== arch) {
			throw new Error(`${output} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		console.log(`buildFpAddon: ${arch}`)
	}
}

if (import.meta.main) {
	buildFpAddon({ dev: process.argv.includes("--dev") })
}
