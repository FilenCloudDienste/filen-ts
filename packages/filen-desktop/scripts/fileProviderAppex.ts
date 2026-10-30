import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { type SignOptions, signAsync } from "@electron/osx-sign"
import { Arch, type AfterPackContext, MacPackager } from "electron-builder"
import { nativeArchOf } from "./nativeArch.ts"

// The File Provider extension (filen-ios-file-provider's FilenFileProviderMac target, a universal unsigned build) in
// Contents/PlugIns. Its path comes from FILEN_DESKTOP_FP_APPEX, which scripts/dist.ts sets from
// scripts/buildFileProvider.ts when unset and the submodules are checked out; a macOS package without it fails, since
// the app would offer Filen in Finder with no extension behind it.

export const APPEX_NAME = "FilenFileProvider.appex"
// CFBundleExecutable of the extension.
export const APPEX_EXECUTABLE = "FilenFileProvider"
const LIPO_ARCH: Record<string, string> = { x64: "x86_64", arm64: "arm64" }

const entitlements = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "build", "entitlements.fileprovider.plist")

export function appexSource(): string {
	const source = process.env["FILEN_DESKTOP_FP_APPEX"]

	if (source === undefined || source.length === 0) {
		throw new Error(
			`FILEN_DESKTOP_FP_APPEX is not set; check out the filen-ios-file-provider and filen-rs submodules (pnpm run dist builds ${APPEX_NAME} from them) or point it at a FilenFileProviderMac build`
		)
	}

	if (!existsSync(path.join(source, "Contents", "MacOS", APPEX_EXECUTABLE))) {
		throw new Error(`FILEN_DESKTOP_FP_APPEX: ${source} is not a ${APPEX_NAME} build`)
	}

	return path.resolve(source)
}

// Owner-writable throughout, so neither signing nor an update's file swap meets a read-only file.
function makeWritable(target: string): void {
	const stats = lstatSync(target)

	if (stats.isSymbolicLink()) {
		return
	}

	chmodSync(target, stats.mode | 0o200)

	if (stats.isDirectory()) {
		for (const entry of readdirSync(target)) {
			makeWritable(path.join(target, entry))
		}
	}
}

function run(command: string, args: string[]): string {
	const result = spawnSync(command, args, { encoding: "utf8" })

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`)
	}

	return result.stdout
}

/**
 * afterPack (macOS): copies the extension into the app, its executable thinned to the build's arch (per-arch checks
 * refuse universal binaries). Signing comes later, in signMac: the fuses step after afterPack re-signs the whole bundle.
 */
export function installAppex(context: AfterPackContext): void {
	if (context.electronPlatformName !== "darwin" || !(context.packager instanceof MacPackager)) {
		return
	}

	const arch = Arch[context.arch]
	const lipoArch = LIPO_ARCH[arch]

	if (lipoArch === undefined) {
		throw new Error(`installAppex: no ${APPEX_NAME} for ${arch}`)
	}

	const plugIns = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "PlugIns")
	const target = path.join(plugIns, APPEX_NAME)
	const executable = path.join(target, "Contents", "MacOS", APPEX_EXECUTABLE)

	rmSync(target, { recursive: true, force: true })
	cpSync(appexSource(), target, { recursive: true, verbatimSymlinks: true })
	makeWritable(plugIns)

	if (run("lipo", ["-archs", executable]).trim() !== lipoArch) {
		run("lipo", [executable, "-thin", lipoArch, "-output", executable])
	}

	const found = nativeArchOf(executable)

	if (found !== arch) {
		throw new Error(`installAppex: ${executable} is ${found ?? "not a single-arch Mach-O"}, not ${arch}`)
	}

	console.log(`installAppex: ${target} (${arch})`)
}

// electron-builder's own signing retries (app-builder-lib codeSign/macCodeSign.js): a timestamp server can fail briefly.
const SIGN_RETRIES = 3
const SIGN_INTERVAL_MS = 5000
const SIGN_BACKOFF_MS = 5000

/**
 * mac.sign: runs after the fuses step and before notarization. Signs the extension first, with its own sandbox
 * entitlements, the hardened runtime and a secure timestamp (never --deep, and electron-builder skips Contents/PlugIns),
 * then signs the app as electron-builder's built-in does; the app's seal covers the signed extension.
 */
export async function signMac(options: SignOptions): Promise<void> {
	const appex = path.join(options.app, "Contents", "PlugIns", APPEX_NAME)

	if (existsSync(appex)) {
		if (options.identity === undefined) {
			throw new Error("signMac: no signing identity")
		}

		const args = ["--force", "--sign", options.identity, "--options", "runtime", "--timestamp", "--entitlements", entitlements]

		if (options.keychain !== undefined) {
			args.push("--keychain", options.keychain)
		}

		run("/usr/bin/codesign", [...args, appex])
		console.log(`signMac: signed ${appex}`)
	}

	for (let attempt = 0; ; attempt++) {
		try {
			await signAsync(options)

			return
		} catch (error) {
			if (attempt >= SIGN_RETRIES) {
				throw error
			}

			await new Promise(resolve => setTimeout(resolve, SIGN_INTERVAL_MS + SIGN_BACKOFF_MS * attempt))
		}
	}
}
