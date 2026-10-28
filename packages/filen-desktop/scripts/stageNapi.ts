import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type } from "arktype"
import { nativeArchOf, type NativeArch } from "./nativeArch.ts"

// Copies the sync addon of every architecture installed for this OS to build/native/<os>-<arch>/sdk-rs.node, where
// electron-builder picks it up per arch (extraResources) and addonPath finds it in development. The addons come from
// @filen/sdk-rs's per-platform packages, or from FILEN_DESKTOP_NAPI_DIR (a filen-rs `build:napi` output directory).
// An architecture whose addon is missing is skipped; electron-builder refuses to package it.
//
// `--dev` (pnpm run dev) stages this machine's architecture only, and copies nothing while the staged addon still
// comes from the source it was copied from, so the dev shell never runs a stale engine at the cost of two stats.
//
//   node scripts/stageNapi.ts [--dev]

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// electron-builder's ${os}.
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", win32: "win", linux: "linux" }
// The ABI suffix of napi-rs's target triple.
const ABI: Partial<Record<NodeJS.Platform, string>> = { win32: "-msvc", linux: "-gnu" }
const ARCHS: NativeArch[] = ["x64", "arm64"]

// What a staged addon was copied from. Beside the per-arch directories, which electron-builder ships whole.
const stampSchema = type({ source: "string", size: "number", mtimeMs: "number" })

export type StageStamp = typeof stampSchema.infer

export function stampOf(source: string): StageStamp {
	const { size, mtimeMs } = statSync(source)

	return { source, size, mtimeMs }
}

// A pnpm install or SDK bump resolves to another real path; a new local build changes the size or time.
export function isCurrent(stamp: unknown, current: StageStamp): boolean {
	const staged = stampSchema(stamp)

	return (
		!(staged instanceof type.errors) &&
		staged.source === current.source &&
		staged.size === current.size &&
		staged.mtimeMs === current.mtimeMs
	)
}

function readStamp(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"))
	} catch {
		return null
	}
}

export function stageNapi(options: { dev: boolean }): void {
	const builderOs = BUILDER_OS[process.platform]

	if (builderOs === undefined) {
		throw new Error(`No sync addon for ${process.platform}`)
	}

	const overrideDir = process.env["FILEN_DESKTOP_NAPI_DIR"]
	// The platform packages are @filen/sdk-rs's optional dependencies, so they resolve from its own (real) directory. Its
	// exports map hides package.json, so the directory is found on disk.
	const fromSdk = createRequire(path.join(realpathSync(path.join(packageDir, "node_modules", "@filen", "sdk-rs")), "package.json"))

	function addonFor(arch: NativeArch): string | null {
		const triple = `${process.platform}-${arch}${ABI[process.platform] ?? ""}`
		const file = `sdk-rs.${triple}.node`

		if (overrideDir !== undefined && overrideDir.length > 0) {
			const candidate = path.resolve(overrideDir, file)

			return existsSync(candidate) ? realpathSync(candidate) : null
		}

		try {
			return realpathSync(fromSdk.resolve(`@filen/sdk-rs-${triple}/${file}`))
		} catch {
			return null
		}
	}

	const archs = options.dev ? ARCHS.filter(arch => arch === process.arch) : ARCHS
	let staged = 0

	for (const arch of archs) {
		const target = path.join(packageDir, "build", "native", `${builderOs}-${arch}`)
		const stampFile = path.join(packageDir, "build", "native", `${builderOs}-${arch}.json`)
		const source = addonFor(arch)
		const stamp = source === null ? null : stampOf(source)

		if (options.dev && stamp !== null && existsSync(path.join(target, "sdk-rs.node")) && isCurrent(readStamp(stampFile), stamp)) {
			staged++

			continue
		}

		// A stale copy must not outlive the addon it came from.
		rmSync(target, { recursive: true, force: true })
		rmSync(stampFile, { force: true })

		if (source === null || stamp === null) {
			console.log(`stageNapi: no ${arch} addon; skipped`)

			continue
		}

		const found = nativeArchOf(source)

		if (found !== arch) {
			throw new Error(`${source} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
		}

		mkdirSync(target, { recursive: true })
		copyFileSync(source, path.join(target, "sdk-rs.node"))
		writeFileSync(stampFile, `${JSON.stringify(stamp)}\n`)
		staged++
		console.log(`stageNapi: ${arch} from ${source}`)
	}

	if (staged === 0) {
		throw new Error("No sync addon to stage; install @filen/sdk-rs or set FILEN_DESKTOP_NAPI_DIR")
	}
}

if (import.meta.main) {
	stageNapi({ dev: process.argv.includes("--dev") })
}
