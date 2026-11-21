import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { builderOs, stagedDirName } from "../src/shared/buildLayout.ts"
import { ASSISTANT_ENGINE_BUNDLE, nodeLlamaCppDir } from "./bundles.ts"
import { ARCHS, packageDir } from "./paths.ts"

// Stages the assistant's engine for every architecture installed for this OS into build/native/<os>-<arch>/llama/,
// which electron-builder ships beside the asar (resources/native/llama/) and nativeFilePath finds in development:
//
//   engine.js                       the engine's utility process (src/assistant/main.ts) with node-llama-cpp bundled,
//                                   as scripts/build.ts bundled it
//   node-llama-cpp/                 what node-llama-cpp reads beside its own code: its package.json and llama/*.json
//   node_modules/@node-llama-cpp/   every prebuilt backend published for <os>-<arch> (Metal; CUDA, Vulkan, CPU), as is
//
// The backends are node-llama-cpp's optional dependencies, installed for both CPUs (pnpm-workspace.yaml
// supportedArchitectures). An architecture without one is skipped; electron-builder's beforePack refuses to package it.
// Runs after scripts/build.ts, and after scripts/stageNapi.ts, which replaces the whole <os>-<arch> directory.
//
//   node scripts/stageLlama.ts [--dev]

// What node-llama-cpp reads from its own package at runtime (config.js, getModuleVersion.js): the release it was
// built from and its version, which a prebuilt package must match.
const PACKAGE_FILES = [
	"package.json",
	"LICENSE",
	path.join("llama", "binariesGithubRelease.json"),
	path.join("llama", "llama.cpp.info.json")
]

// The backends published for `os` and `arch`, as installed beside node-llama-cpp.
export function backendPackages(installed: readonly string[], os: string, arch: string): string[] {
	return installed.filter(name => name === `${os}-${arch}` || name.startsWith(`${os}-${arch}-`)).sort()
}

export function stageLlama(options: { dev: boolean }): void {
	const os = builderOs(process.platform)

	if (os === undefined) {
		throw new Error(`No assistant engine for ${process.platform}`)
	}

	const library = nodeLlamaCppDir()
	const backendsDir = path.join(path.dirname(library), "@node-llama-cpp")
	const installed = existsSync(backendsDir) ? readdirSync(backendsDir) : []
	const archs = options.dev ? ARCHS.filter(arch => arch === process.arch) : ARCHS
	const bundle = path.join(packageDir, ASSISTANT_ENGINE_BUNDLE)
	let staged = 0

	if (!existsSync(bundle)) {
		throw new Error(`No ${ASSISTANT_ENGINE_BUNDLE}; run scripts/build.ts first`)
	}

	for (const arch of archs) {
		const target = path.join(packageDir, "build", "native", stagedDirName(process.platform, arch), "llama")
		const packages = backendPackages(installed, os, arch)

		rmSync(target, { recursive: true, force: true })

		if (packages.length === 0) {
			console.log(`stageLlama: no ${os}-${arch} backend installed; skipped`)

			continue
		}

		mkdirSync(target, { recursive: true })
		cpSync(bundle, path.join(target, "engine.js"))

		for (const file of PACKAGE_FILES) {
			cpSync(path.join(library, file), path.join(target, "node-llama-cpp", file))
		}

		for (const name of packages) {
			const source = realpathSync(path.join(backendsDir, name))
			const { version } = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")) as { version: string }

			cpSync(source, path.join(target, "node_modules", "@node-llama-cpp", name), { recursive: true, dereference: true })
			console.log(`stageLlama: ${arch} ${name}@${version}`)
		}

		staged++
	}

	if (staged === 0) {
		throw new Error("No assistant engine backend to stage; install node-llama-cpp's platform packages")
	}
}

if (import.meta.main) {
	stageLlama({ dev: process.argv.includes("--dev") })
}
