// Builds a package's wasm module (<package>/crate, wasm32-unknown-unknown, release) and copies it to
// <package>/dist/<artifact>.wasm, for @filen/spellcheck and @filen/encoding-detect alike: each package's
// scripts/build-wasm.mjs is a short call into this. Cargo builds incrementally, so a run without changes takes well
// under a second. The toolchain and target come from the package's rust-toolchain.toml; rustup installs them on
// first use.

import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const TARGET = "wasm32-unknown-unknown"

const MISSING_RUST =
	"cargo is not installed: install rustup (https://rustup.rs); the toolchain in rust-toolchain.toml is fetched on first use"

// Panic locations embed source paths: mapped to fixed prefixes, the module is the same bytes whoever builds
// it from wherever (the checkout, CARGO_HOME and the toolchain directory differ between machines).
function reproducibleFlags(crateDir, remapName) {
	const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
	let sysroot

	try {
		sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: crateDir, encoding: "utf8" }).trim()
	} catch (error) {
		throw error.code === "ENOENT" ? new Error(MISSING_RUST) : error
	}
	const remaps = [
		[crateDir, remapName],
		[cargoHome, "/cargo"],
		[sysroot, "/rustup"]
	]
	const own = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
	const inherited = process.env.CARGO_ENCODED_RUSTFLAGS

	// CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f; it takes precedence over RUSTFLAGS and config.
	return [...(inherited === undefined || inherited === "" ? [] : inherited.split("\x1f")), ...own].join("\x1f")
}

function cargo(crateDir, remapName, args) {
	return new Promise((resolve, reject) => {
		const child = spawn("cargo", args, {
			cwd: crateDir,
			stdio: ["ignore", "inherit", "inherit"],
			env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: reproducibleFlags(crateDir, remapName) }
		})

		child.on("error", error => {
			reject(error.code === "ENOENT" ? new Error(MISSING_RUST) : error)
		})
		child.on("exit", code => {
			if (code === 0) resolve()
			else reject(new Error(`cargo ${args.join(" ")} exited with ${String(code)}`))
		})
	})
}

function same(a, b) {
	try {
		return statSync(a).size === statSync(b).size && readFileSync(a).equals(readFileSync(b))
	} catch {
		return false
	}
}

// packageDir ends in a separator (fileURLToPath of the package's directory URL); artifact is the crate's wasm file
// name without the extension; remapName is the fixed prefix the crate's own paths are mapped to.
export function rustWasmBuild({ packageDir, artifact, remapName }) {
	const crateDir = `${packageDir}crate`
	// Passed as --target-dir, so CARGO_TARGET_DIR or a configured build.target-dir cannot move the output away from
	// built.
	const targetDir = `${crateDir}/target`
	const built = `${targetDir}/${TARGET}/release/${artifact}.wasm`
	const wasmPath = `${packageDir}dist/${artifact}.wasm`

	// Builds when sources changed and returns the module's path and size.
	async function buildWasm() {
		await cargo(crateDir, remapName, ["build", "--release", "--locked", "--target", TARGET, "--target-dir", targetDir])

		if (!same(built, wasmPath)) {
			mkdirSync(`${packageDir}dist`, { recursive: true })
			copyFileSync(built, wasmPath)
		}

		return { path: wasmPath, bytes: statSync(wasmPath).size }
	}

	return { WASM_PATH: wasmPath, buildWasm }
}

// The package script's CLI tail: builds when run directly and prints the module's path and size.
export async function runIfMain(moduleUrl, buildWasm) {
	if (process.argv[1] !== fileURLToPath(moduleUrl)) {
		return
	}

	const { path, bytes } = await buildWasm()

	console.log(`${path}: ${String(bytes)} bytes`)
}
