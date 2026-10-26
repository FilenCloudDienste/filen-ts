import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeArchOf, type NativeArch } from "./nativeArch.ts"

// Copies the sync addon of every architecture installed for this OS to build/native/<os>-<arch>/sdk-rs.node, where
// electron-builder picks it up per arch (extraResources) and addonPath finds it in development. The addons come from
// @filen/sdk-rs's per-platform packages, or from FILEN_DESKTOP_NAPI_DIR (a filen-rs `build:napi` output directory).
// An architecture whose addon is missing is skipped; electron-builder refuses to package it.
//
//   node scripts/stageNapi.ts

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// electron-builder's ${os}.
const BUILDER_OS: Partial<Record<NodeJS.Platform, string>> = { darwin: "mac", win32: "win", linux: "linux" }
// The ABI suffix of napi-rs's target triple.
const ABI: Partial<Record<NodeJS.Platform, string>> = { win32: "-msvc", linux: "-gnu" }
const ARCHS: NativeArch[] = ["x64", "arm64"]

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

		return existsSync(candidate) ? candidate : null
	}

	try {
		return fromSdk.resolve(`@filen/sdk-rs-${triple}/${file}`)
	} catch {
		return null
	}
}

let staged = 0

for (const arch of ARCHS) {
	const target = path.join(packageDir, "build", "native", `${builderOs}-${arch}`)
	const source = addonFor(arch)

	// A stale copy must not outlive the addon it came from.
	rmSync(target, { recursive: true, force: true })

	if (source === null) {
		console.log(`stageNapi: no ${arch} addon; skipped`)

		continue
	}

	const found = nativeArchOf(source)

	if (found !== arch) {
		throw new Error(`${source} is built for ${found ?? "an unknown architecture"}, not ${arch}`)
	}

	mkdirSync(target, { recursive: true })
	copyFileSync(source, path.join(target, "sdk-rs.node"))
	staged++
	console.log(`stageNapi: ${arch} from ${source}`)
}

if (staged === 0) {
	throw new Error("No sync addon to stage; install @filen/sdk-rs or set FILEN_DESKTOP_NAPI_DIR")
}
