import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { APPEX_NAME } from "../src/main/fileProvider/addon.ts"
import { APPEX_EXECUTABLE } from "./fileProviderAppex.ts"

// Builds the File Provider extension from the filen-ios-file-provider and filen-rs submodules: the universal macOS
// xcframework (build-rust.sh --macos), then the FilenFileProviderMac target, universal and unsigned, to
// build/fileProvider/Products/Release. Nothing is rebuilt while both submodules are clean at the commits the last
// build came from. Run as a script, it prints the appex path and, in CI, exports it as FILEN_DESKTOP_FP_APPEX.
//
//   node scripts/buildFileProvider.ts

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const providerDir = path.join(packageDir, "filen-ios-file-provider")
const rustDir = path.join(packageDir, "filen-rs")
const outDir = path.join(packageDir, "build", "fileProvider")
const appex = path.join(outDir, "Products", "Release", APPEX_NAME)
const stampFile = path.join(outDir, "stamp")
const UNIVERSAL = ["arm64", "x86_64"]

export function fileProviderSubmodulesPresent(): boolean {
	return existsSync(path.join(providerDir, "build-rust.sh")) && existsSync(path.join(rustDir, "Cargo.toml"))
}

function git(dir: string, args: string[]): string {
	const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })

	if (result.status !== 0) {
		throw new Error(`git -C ${dir} ${args.join(" ")} failed: ${result.stderr.trim()}`)
	}

	return result.stdout.trim()
}

// The commits both submodules are at, or null while either has local changes (which always rebuild). Build outputs
// in them are gitignored.
function sourceStamp(): string | null {
	const dirs = [providerDir, rustDir]

	if (dirs.some(dir => git(dir, ["status", "--porcelain"]) !== "")) {
		return null
	}

	return dirs.map(dir => git(dir, ["rev-parse", "HEAD"])).join(" ")
}

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, { cwd, stdio: "inherit" })

	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.signal ?? String(result.status)})`)
	}
}

export function buildFileProvider(): string {
	if (!fileProviderSubmodulesPresent()) {
		throw new Error("buildFileProvider: the filen-ios-file-provider and filen-rs submodules are not checked out")
	}

	const stamp = sourceStamp()

	if (stamp !== null && existsSync(appex) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
		console.log(`buildFileProvider: ${appex} is up to date`)

		return appex
	}

	rmSync(stampFile, { force: true })
	run("bash", ["build-rust.sh", "--macos", "--rust-dir", rustDir, "--rust-crate-name", "filen-mobile-native-cache"], providerDir)
	run(
		"xcodebuild",
		[
			"-project",
			path.join(providerDir, "FilenFileProvider.xcodeproj"),
			"-target",
			"FilenFileProviderMac",
			"-configuration",
			"Release",
			"-quiet",
			`ARCHS=${UNIVERSAL.join(" ")}`,
			"ONLY_ACTIVE_ARCH=NO",
			`SYMROOT=${path.join(outDir, "Products")}`,
			`OBJROOT=${path.join(outDir, "Intermediates")}`,
			"build"
		],
		providerDir
	)

	const executable = path.join(appex, "Contents", "MacOS", APPEX_EXECUTABLE)
	const lipo = spawnSync("lipo", ["-archs", executable], { encoding: "utf8" })
	const archs = lipo.status === 0 ? lipo.stdout.trim().split(/\s+/).sort() : []

	if (archs.join(" ") !== UNIVERSAL.join(" ")) {
		throw new Error(`buildFileProvider: ${executable} is ${archs.join(" ") || "missing"}, not ${UNIVERSAL.join(" ")}`)
	}

	if (stamp !== null) {
		writeFileSync(stampFile, stamp)
	}

	return appex
}

if (import.meta.main) {
	const built = buildFileProvider()
	const githubEnv = process.env["GITHUB_ENV"]

	if (githubEnv !== undefined && githubEnv.length > 0) {
		appendFileSync(githubEnv, `FILEN_DESKTOP_FP_APPEX=${built}\n`)
	}

	console.log(`FILEN_DESKTOP_FP_APPEX=${built}`)
}
