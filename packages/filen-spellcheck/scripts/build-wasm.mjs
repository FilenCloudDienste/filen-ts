// Builds the spellchecker's wasm module (crate/, wasm32-unknown-unknown, release) and copies it to
// dist/filen_spellcheck.wasm. Cargo builds incrementally, so a run without changes takes well under a second.
// The toolchain and target come from rust-toolchain.toml; rustup installs them on first use.
//
//   pnpm run build:wasm

import { execFileSync, spawn } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url))
const CRATE_DIR = `${PACKAGE_DIR}crate`
const TARGET = "wasm32-unknown-unknown"
// Passed as --target-dir, so CARGO_TARGET_DIR or a configured build.target-dir cannot move the output away from BUILT.
const TARGET_DIR = `${CRATE_DIR}/target`
const BUILT = `${TARGET_DIR}/${TARGET}/release/filen_spellcheck.wasm`

const MISSING_RUST =
	"cargo is not installed: install rustup (https://rustup.rs); the toolchain in rust-toolchain.toml is fetched on first use"

export const WASM_PATH = `${PACKAGE_DIR}dist/filen_spellcheck.wasm`

// Panic locations embed source paths: mapped to fixed prefixes, the module is the same bytes whoever builds
// it from wherever (the checkout, CARGO_HOME and the toolchain directory differ between machines).
function reproducibleFlags() {
	const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo")
	let sysroot

	try {
		sysroot = execFileSync("rustc", ["--print", "sysroot"], { cwd: CRATE_DIR, encoding: "utf8" }).trim()
	} catch (error) {
		throw error.code === "ENOENT" ? new Error(MISSING_RUST) : error
	}
	const remaps = [
		[CRATE_DIR, "/filen-spellcheck"],
		[cargoHome, "/cargo"],
		[sysroot, "/rustup"]
	]
	const own = remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
	const inherited = process.env.CARGO_ENCODED_RUSTFLAGS

	// CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f; it takes precedence over RUSTFLAGS and config.
	return [...(inherited === undefined || inherited === "" ? [] : inherited.split("\x1f")), ...own].join("\x1f")
}

function cargo(args) {
	return new Promise((resolve, reject) => {
		const child = spawn("cargo", args, {
			cwd: CRATE_DIR,
			stdio: ["ignore", "inherit", "inherit"],
			env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: reproducibleFlags() }
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

// Builds when sources changed and returns the module's path and size.
export async function buildWasm() {
	await cargo(["build", "--release", "--locked", "--target", TARGET, "--target-dir", TARGET_DIR])

	if (!same(BUILT, WASM_PATH)) {
		mkdirSync(`${PACKAGE_DIR}dist`, { recursive: true })
		copyFileSync(BUILT, WASM_PATH)
	}

	return { path: WASM_PATH, bytes: statSync(WASM_PATH).size }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { path, bytes } = await buildWasm()

	console.log(`${path}: ${String(bytes)} bytes`)
}
