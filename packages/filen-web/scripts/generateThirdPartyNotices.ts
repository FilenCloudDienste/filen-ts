import { isUtf8 } from "node:buffer"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	describeCargoCrate,
	describedNotice,
	finalizeNotices,
	listInstalledNpm,
	readJson,
	repositoryOf,
	sortNoticeTexts,
	spdxOf,
	splitCopyright,
	vendoredNotice,
	type CollectedNotice,
	type InstalledNpmPackage
} from "@filen/shared/tooling"
import type { AssistantModelManifest } from "../src/features/assistant/runtime/manifest"
import { QWEN35_4B } from "../src/features/assistant/runtime/models"

/**
 * Emits the third-party attribution payload the Open source licenses dialog renders.
 *
 * MIT, BSD and Apache-2.0 all require the license text AND the copyright notice to accompany the
 * distribution, so listing package names and SPDX ids would not discharge the obligation — the text has
 * to ship inside the app.
 *
 * Shipping it verbatim per package would be megabytes, because an MIT file is identical everywhere
 * except its copyright line. So the copyright lines are lifted out and stored per package, and what
 * remains — the boilerplate — is deduplicated across every package that shares it. Nothing is
 * summarised or paraphrased; a rendered notice is copyright line plus verbatim boilerplate.
 *
 * A package whose license file cannot be found keeps its SPDX id and repository URL and points at no
 * text. Substituting another package's text of the same license would attribute the wrong copyright
 * holder, which is worse than an honest gap.
 *
 * Four sources reach the browser: the npm tree (minus dev/optional entries, which are build tooling),
 * the Rust crates the SDK and spellchecker wasm modules are compiled from, components vendored into
 * this package as built output, described from the manifest their build script writes, and the
 * assistant's model weights, which Filen serves from its own host. @filen/sdk-rs is
 * a registry package and is described here; @filen/shared, @filen/office and @filen/spellcheck are
 * workspace members, so pnpm does not report them and they are correctly absent — first-party code needs
 * no attribution. Their dependencies are reported through them; their peers are reported only because this
 * package declares each one, as the app that provides them (src/tests/thirdPartyNotices.test.ts fails on a
 * peer it does not). The third-party material @filen/office and @filen/spellcheck carry (fonts, derived
 * code, crates, dictionaries) is vendored and described from their own records.
 *
 * The licensing core is shared with filen-mobile's generator through @filen/shared/tooling. Unlike
 * mobile, the npm dedup key here is `name@version` rather than the bare name (this tree ships 30
 * packages at two versions, and a bare-name key would silently describe only one of each pair).
 *
 * CANNOT RUN IN CI: it needs a filen-rs checkout and the local cargo caches. Re-run after any
 * @filen/sdk-rs bump; the payload's exported SDK version is checked against the installed tree by
 * src/tests/thirdPartyNotices.test.ts, so a stale payload fails there rather than shipping quietly.
 *
 * Run from the package root (tsx, for the app's path alias the model manifest imports with):
 *   pnpm exec tsx scripts/generateThirdPartyNotices.ts
 *   --filen-rs=<path>   filen-rs checkout to read the crate lockfile from
 *   --allow-untagged    read the checkout's working tree instead of the release tag (local experiment
 *                       only — the payload is then stamped worktree@<sha> and fails the payload test)
 */

const OUTPUT = "src/features/settings/thirdPartyNotices.gen.ts"
const WORKSPACE_FILE = "../../pnpm-workspace.yaml"
const FILEN_TS_REPOSITORY = "https://github.com/FilenCloudDienste/filen-ts"

type Ecosystem = "npm" | "rust" | "vendored"

type Collected = CollectedNotice<Ecosystem>

function requireJson(path: string): Record<string, unknown> {
	const json = readJson(path)

	if (json === null) {
		throw new Error(`could not read ${path}`)
	}

	return json
}

/**
 * The patch pnpm applies to a package, by `name@version` (or a bare name, for every version), from
 * pnpm-workspace.yaml's patchedDependencies. What ships is the patched source, so its notice names the patch.
 */
function patchedDependencies(): Map<string, string> {
	const patches = new Map<string, string>()
	let inSection = false

	for (const line of readFileSync(WORKSPACE_FILE, "utf8").split("\n")) {
		if (!/^\s/.test(line)) {
			inSection = line.trimEnd() === "patchedDependencies:"

			continue
		}

		const match = inSection ? /^\s+'?(.+?)'?:\s+(\S+)\s*$/.exec(line) : null

		if (match?.[1] !== undefined && match[2] !== undefined) {
			patches.set(match[1], match[2])
		}
	}

	return patches
}

/**
 * The npm packages that reach a browser.
 *
 * Identity is `name@version`, not the bare name: several packages ship at two versions in this tree and
 * both are distributed, so a name-keyed dedup would describe only one of each pair.
 */
function collectNpm(installed: InstalledNpmPackage[]): Collected[] {
	const seen = new Set<string>()
	const entries: Collected[] = []
	const patches = patchedDependencies()

	for (const { name, version, dir } of installed) {
		const id = `${name}@${version}`

		if (seen.has(id) || dir === null) {
			continue
		}

		const manifest = readJson(join(dir, "package.json"))

		// Marked seen only once actually described: an id pnpm reports but no directory can supply stays
		// undescribed and fails the payload's drift guard loudly rather than silently.
		if (!manifest) {
			continue
		}

		const manifestVersion = manifest["version"]

		if (typeof manifestVersion === "string" && manifestVersion !== version) {
			throw new Error(`${id}: pnpm says ${version}, ${dir}/package.json says ${manifestVersion} — run pnpm install`)
		}

		seen.add(id)

		const entry = describedNotice({
			name,
			version,
			license: spdxOf(manifest["license"] ?? manifest["licenses"]),
			ecosystem: "npm",
			dir,
			repository: repositoryOf(manifest["repository"])
		})
		const patch = patches.get(id) ?? patches.get(name)

		// The source of what ships (MPL-2.0 and the LGPL ask for it): the release as published, with the patch.
		entries.push(
			patch === undefined
				? entry
				: {
						...entry,
						terms: [
							`Modified: ${name} ${version} as published, with the patch ${patch} from the filen-ts repository (${FILEN_TS_REPOSITORY}) applied. That patch is the whole of the change to its source.`,
							...entry.terms
						]
					}
		)
	}

	return entries
}

function argValue(flag: string): string | undefined {
	return process.argv
		.slice(2)
		.find(arg => arg.startsWith(`${flag}=`))
		?.slice(flag.length + 1)
}

function git(checkout: string, args: string[]): string {
	return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Which filen-rs checkout the crate list comes from, and which of the three candidates supplied it.
 *
 * The monorepo's `packages/filen-mobile/filen-rs` submodule is deliberately NOT a candidate: it is
 * pinned by mobile's native build on mobile's schedule and routinely sits at a different SDK release,
 * so falling through to it would attribute one release's crates to another's wasm.
 */
function resolveCheckout(): { path: string; source: string } {
	const candidates: { path: string; source: string }[] = [
		{ path: argValue("--filen-rs") ?? "", source: "--filen-rs" },
		{ path: process.env["FILEN_RS_PATH"] ?? "", source: "FILEN_RS_PATH" },
		{ path: "../../../filen-rs", source: "sibling" }
	]

	for (const candidate of candidates) {
		if (candidate.path.length > 0 && existsSync(join(candidate.path, "Cargo.lock"))) {
			return candidate
		}
	}

	throw new Error(
		`no filen-rs checkout with a Cargo.lock — tried ${candidates.map(c => `${c.source}=${c.path.length > 0 ? c.path : "(unset)"}`).join(", ")}`
	)
}

/** The crate sources cargo keeps on this machine: registry crates plus git-dependency checkouts. */
function crateSourceRoots(): string[] {
	const roots: string[] = []

	for (const base of [join(homedir(), ".cargo", "registry", "src"), join(homedir(), ".cargo", "git", "checkouts")]) {
		if (!existsSync(base)) {
			continue
		}

		for (const entry of readdirSync(base)) {
			roots.push(join(base, entry))
		}
	}

	return roots
}

/**
 * The Rust crates the shipped wasm is compiled from, read at the RELEASE TAG matching the installed
 * @filen/sdk-rs version.
 *
 * Reading the checkout's working tree instead would attribute whatever the branch happens to be at —
 * measurably a different crate set — and a version equality check alone cannot catch that, because the
 * working tree still declares the same version.
 */
function collectRust(expected: string): { entries: Collected[]; ref: string; source: string; crates: number } {
	const checkout = resolveCheckout()
	const tag = `filen-js@${expected}`
	const allowUntagged = process.argv.includes("--allow-untagged")
	let ref = tag

	try {
		git(checkout.path, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`])
	} catch {
		if (!allowUntagged) {
			throw new Error(`${checkout.path} has no tag ${tag} — fetch it (git -C ${checkout.path} fetch --tags) or pass --allow-untagged`)
		}

		ref = `worktree@${git(checkout.path, ["rev-parse", "--short", "HEAD"]).trim()}`
	}

	const atTag = ref === tag
	const cargoToml = atTag
		? git(checkout.path, ["show", `${tag}:filen-sdk-rs/Cargo.toml`])
		: readFileSync(join(checkout.path, "filen-sdk-rs", "Cargo.toml"), "utf8")
	const cargoLock = atTag ? git(checkout.path, ["show", `${tag}:Cargo.lock`]) : readFileSync(join(checkout.path, "Cargo.lock"), "utf8")
	const declared = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml.split("[dependencies]")[0] ?? cargoToml)?.[1]

	if (declared !== expected) {
		throw new Error(`${checkout.path} at ${ref} declares filen-sdk-rs ${declared ?? "(none)"}, expected ${expected}`)
	}

	const roots = crateSourceRoots()
	const entries: Collected[] = []
	const byId = new Map<string, Collected>()
	let crates = 0

	for (const match of cargoLock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g)) {
		const [, name, version, source] = match

		// No `source` means a workspace member — Filen's own code, not a third party.
		if (!source || !name || !version) {
			continue
		}

		crates++

		// A registry crate unpacks to <root>/<name>-<version>; a git dependency to a checkout directory
		// named after the abbreviated revision from the source URL's fragment.
		const rev = /#([0-9a-f]+)$/.exec(source)?.[1]
		const dir =
			roots.map(root => join(root, `${name}-${version}`)).find(existsSync) ??
			(rev === undefined
				? undefined
				: roots
						.flatMap(root => {
							try {
								return readdirSync(root).map(entry => ({ entry, path: join(root, entry) }))
							} catch {
								return []
							}
						})
						.find(({ entry }) => rev.startsWith(entry))?.path)

		if (dir === undefined) {
			throw new Error(`no local source for crate ${name}-${version} — run cargo fetch in ${checkout.path}`)
		}

		const entry = describeCargoCrate(name, version, dir)

		// The same crate version can be locked twice — once from crates.io and once from a git fork of it.
		// Identical attribution is one notice, not two (the payload is keyed by name@version). Attribution
		// that actually differs is a real ambiguity and throws rather than silently dropping one holder.
		const previous = byId.get(`${name}@${version}`)

		if (previous !== undefined) {
			if (JSON.stringify({ ...previous, texts: [] }) !== JSON.stringify(entry)) {
				throw new Error(
					`crate ${name}-${version} is locked twice with differing attribution (${previous.license} vs ${entry.license})`
				)
			}

			continue
		}

		byId.set(`${name}@${version}`, entry)
		entries.push(entry)
	}

	return { entries, ref, source: checkout.source, crates }
}

// The one definition of "the installed SDK": what pnpm reports for the installed tree, which is also
// what the payload test reads. The symlink under node_modules is the cross-check, so an edited
// package.json with no install cannot generate a payload that only fails later.
const installed = listInstalledNpm("@filen/web")
const expectedSdk = installed.find(entry => entry.name === "@filen/sdk-rs")?.version

if (typeof expectedSdk !== "string" || expectedSdk.length === 0) {
	throw new Error("the installed tree has no @filen/sdk-rs — run `pnpm install` at the repo root")
}

const installedSdk = requireJson("node_modules/@filen/sdk-rs/package.json")["version"]

if (installedSdk !== expectedSdk) {
	throw new Error(`pnpm says @filen/sdk-rs ${expectedSdk}, node_modules says ${String(installedSdk)} — run pnpm install`)
}

function stringField(record: Record<string, unknown>, key: string, path: string): string {
	const value = record[key]

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path}: "${key}" is missing`)
	}

	return value
}

function stringsField(record: Record<string, unknown>, key: string, path: string): string[] {
	const value = record[key]

	if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === "string")) {
		throw new Error(`${path}: "${key}" is missing`)
	}

	return value
}

function objectField(record: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
	const value = record[key]

	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path}: "${key}" is missing`)
	}

	return Object.fromEntries(Object.entries(value))
}

/**
 * The FFmpeg decoders module, built to WebAssembly by scripts/codecs/build-ffmpeg-decoders.sh. What it
 * contains is read from the manifest the build writes, so the notices cannot drift from what is shipped:
 *
 * - FFmpeg configured without --enable-gpl or --enable-nonfree, LGPL-2.1-or-later
 *   (https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md). The text is FFmpeg's own COPYING.LGPLv2.1,
 *   kept verbatim beside this script. The corresponding source is named by path and SHA-256: the commit
 *   that ships a build is not known when the build is made.
 * - Emscripten's runtime and emmalloc (MIT OR NCSA) and musl (MIT), statically linked in; their license
 *   files are copied next to the module by the build. compiler-rt's builtins are linked too, but under
 *   LLVM's exception to Apache-2.0 an object form embedding them owes no attribution.
 */
const FFMPEG_DIR = "src/vendor/ffmpeg-decoders"
const FFMPEG_MANIFEST = `${FFMPEG_DIR}/manifest.json`
const CODECS_SOURCE = "packages/filen-web/scripts/codecs"
const FFMPEG_REPOSITORY = "https://git.ffmpeg.org/ffmpeg.git"

function ffmpegModuleNotices(): Collected[] {
	const manifest = requireJson(FFMPEG_MANIFEST)
	const ffmpeg = objectField(manifest, "ffmpeg", FFMPEG_MANIFEST)
	const emscripten = objectField(manifest, "emscripten", FFMPEG_MANIFEST)
	const sources = objectField(manifest, "sources", FFMPEG_MANIFEST)
	const tag = stringField(ffmpeg, "tag", FFMPEG_MANIFEST)
	const emcc = stringField(manifest, "emcc", FFMPEG_MANIFEST)
	const linkedInto = `Statically linked into the FFmpeg decoders module (${FFMPEG_DIR}/decoders.worker.js), built with Emscripten ${emcc}.`
	const sourceList = ["build-ffmpeg-decoders.sh", "bridge.c", "decoder-worker.js"]
		.map(name => `${CODECS_SOURCE}/${name} (SHA-256 ${stringField(sources, name, FFMPEG_MANIFEST)})`)
		.join(", ")

	return [
		vendoredNotice(
			{
				name: "FFmpeg",
				version: tag.replace(/^n/, ""),
				license: "LGPL-2.1-or-later",
				copyright: ["Copyright (c) the FFmpeg developers"],
				repository: FFMPEG_REPOSITORY,
				terms: [
					[
						`FFmpeg's AC-3, E-AC-3, DTS, TrueHD/MLP, ALAC and FLAC decoders (libavcodec, libavutil), built to WebAssembly from the FFmpeg ${tag} release and licensed under the GNU Lesser General Public License, version 2.1 or later.`,
						`Corresponding source of the library: the FFmpeg release tarball ${stringField(ffmpeg, "tarball", FFMPEG_MANIFEST)} (SHA-256 ${stringField(ffmpeg, "sha256", FFMPEG_MANIFEST)}), unmodified, the release tagged ${tag} in ${FFMPEG_REPOSITORY}.`,
						`Configured with: ${stringsField(ffmpeg, "configure", FFMPEG_MANIFEST).join(" ")}.`,
						`Built with Emscripten ${emcc}. The rest of the module's source and its build recipe, in the filen-ts repository (${FILEN_TS_REPOSITORY}): ${sourceList}.`,
						`That script builds the module (packages/filen-web/${FFMPEG_DIR}/decoders.worker.js) from the tarball above, or from a modified FFmpeg, and the app built from the same repository runs the module that file then holds.`
					].join(" "),
					readFileSync("scripts/licenses/ffmpeg-COPYING.LGPLv2.1", "utf8")
				]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "Emscripten",
				version: emcc,
				license: "MIT OR NCSA",
				copyright: ["Copyright (c) 2010-2014 Emscripten authors"],
				repository: "https://github.com/emscripten-core/emscripten",
				terms: [
					`The Emscripten runtime and emmalloc. ${linkedInto}`,
					readFileSync(`${FFMPEG_DIR}/licenses/emscripten-LICENSE`, "utf8")
				]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "musl",
				version: stringField(emscripten, "musl", FFMPEG_MANIFEST),
				license: "MIT",
				copyright: ["Copyright © 2005-2020 Rich Felker, et al."],
				repository: "https://git.musl-libc.org/cgit/musl",
				terms: [
					`The musl C library, as bundled with Emscripten. ${linkedInto}`,
					readFileSync(`${FFMPEG_DIR}/licenses/musl-COPYRIGHT`, "utf8")
				]
			},
			"vendored"
		)
	]
}

/**
 * The assistant's inference engine, wllama's WebAssembly build of llama.cpp, rebuilt by
 * scripts/wllama/build-wllama.sh with a patch to its glue code and to llama.cpp. wllama itself (MIT) is
 * described with its npm package, whose JavaScript runs the engine. What the module compiles in, read from
 * the manifest the build writes, each with the license file the build copied:
 *
 * - llama.cpp and ggml (MIT), including the YaRN rope code (MIT, Jeffrey Quesnelle and Bowen Peng), whose
 *   copyright line sits in its source file.
 * - nlohmann/json (MIT), the one library llama.cpp vendors on terms that ask for attribution; stb_image,
 *   miniaudio, the base64 and the sha256 code are dedicated to the public domain.
 * - Dawn's C++ WebGPU headers (BSD-3-Clause).
 * - Emscripten's runtime and the C WebGPU implementation Dawn's package carries (both MIT OR NCSA), and
 *   musl (MIT). libc++, libc++abi and compiler-rt are linked too, under LLVM's exception to Apache-2.0,
 *   which asks no attribution of an object form.
 */
const WLLAMA_DIR = "src/vendor/wllama"
const WLLAMA_MANIFEST = `${WLLAMA_DIR}/manifest.json`
const WLLAMA_SOURCE = "packages/filen-web/scripts/wllama"

function wllamaEngineNotices(): Collected[] {
	const manifest = requireJson(WLLAMA_MANIFEST)
	const wllama = objectField(manifest, "wllama", WLLAMA_MANIFEST)
	const llamaCpp = objectField(manifest, "llama.cpp", WLLAMA_MANIFEST)
	const json = objectField(manifest, "nlohmann/json", WLLAMA_MANIFEST)
	const dawn = objectField(manifest, "dawn", WLLAMA_MANIFEST)
	const emscripten = objectField(manifest, "emscripten", WLLAMA_MANIFEST)
	const sources = objectField(manifest, "sources", WLLAMA_MANIFEST)
	const commit = stringField(llamaCpp, "commit", WLLAMA_MANIFEST)
	const emcc = stringField(manifest, "emcc", WLLAMA_MANIFEST)
	const emscriptenVersion = emcc.split(" ")[0] ?? emcc
	const license = (file: string) => readFileSync(`${WLLAMA_DIR}/licenses/${file}`, "utf8")
	const linkedInto = `Compiled into the assistant's inference engine (${WLLAMA_DIR}/wllama.wasm), built with Emscripten ${emcc}.`
	const sourceList = Object.keys(sources)
		.map(name => `${WLLAMA_SOURCE}/${name} (SHA-256 ${stringField(sources, name, WLLAMA_MANIFEST)})`)
		.join(", ")

	return [
		vendoredNotice(
			{
				name: "llama.cpp",
				version: commit.slice(0, 7),
				license: "MIT",
				copyright: ["Copyright (c) 2023-2026 The ggml authors", "Copyright (c) 2023 Jeffrey Quesnelle and Bowen Peng"],
				repository: stringField(llamaCpp, "repository", WLLAMA_MANIFEST),
				terms: [
					[
						`llama.cpp and ggml at commit ${commit}, as the wllama ${stringField(wllama, "version", WLLAMA_MANIFEST)} release (${stringField(wllama, "repository", WLLAMA_MANIFEST)}, commit ${stringField(wllama, "commit", WLLAMA_MANIFEST)}) builds them, with its WebGPU backend. ${linkedInto}`,
						`The build recipe and the patch applied to wllama's glue code and to llama.cpp, in the filen-ts repository (${FILEN_TS_REPOSITORY}): ${sourceList}.`
					].join(" "),
					license("llama.cpp-LICENSE")
				]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "nlohmann/json",
				version: stringField(json, "version", WLLAMA_MANIFEST),
				license: "MIT",
				copyright: ["Copyright (c) 2013-2025 Niels Lohmann"],
				repository: "https://github.com/nlohmann/json",
				terms: [`JSON for Modern C++, as vendored by llama.cpp. ${linkedInto}`, license("nlohmann-json-LICENSE")]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "Dawn",
				version: stringField(dawn, "tag", WLLAMA_MANIFEST),
				license: "BSD-3-Clause",
				copyright: ["Copyright 2017-2025 The Dawn & Tint Authors"],
				repository: "https://dawn.googlesource.com/dawn",
				terms: [
					`Dawn's C++ WebGPU headers, from its Emscripten package (${stringField(dawn, "package", WLLAMA_MANIFEST)}). ${linkedInto}`,
					license("dawn-LICENSE")
				]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "Emscripten",
				version: emscriptenVersion,
				license: "MIT OR NCSA",
				copyright: ["Copyright (c) 2010-2014 Emscripten authors"],
				repository: "https://github.com/emscripten-core/emscripten",
				terms: [
					`The Emscripten runtime, and the C WebGPU implementation in Dawn's package. ${linkedInto}`,
					license("emscripten-LICENSE")
				]
			},
			"vendored"
		),
		vendoredNotice(
			{
				name: "musl",
				version: stringField(emscripten, "musl", WLLAMA_MANIFEST),
				license: "MIT",
				copyright: ["Copyright © 2005-2020 Rich Felker, et al."],
				repository: "https://git.musl-libc.org/cgit/musl",
				terms: [`The musl C library, as bundled with Emscripten. ${linkedInto}`, license("musl-COPYRIGHT")]
			},
			"vendored"
		)
	]
}

/**
 * The assistant's language model. Filen redistributes the weights from its model host, so their license
 * travels with them (Apache-2.0 §4(a)). What ships is read from the pinned manifest; the license file
 * is kept verbatim beside this script under the manifest's id, so pinning another model fails here until
 * its license is added.
 */
const MODEL_MANIFEST_SOURCE = "src/features/assistant/runtime/models.ts"

function assistantModelNotice(manifest: AssistantModelManifest): Collected {
	const text = readFileSync(`scripts/licenses/${manifest.id}-LICENSE`, "utf8")
	// The holder sits in the appendix of an Apache-2.0 file, which splitCopyright rightly leaves in the terms.
	const copyright = [...text.matchAll(/^\s*(Copyright \d{4}\b.*\S)\s*$/gm)].flatMap(match => (match[1] === undefined ? [] : [match[1]]))
	const { repo, revision } = manifest.source
	const repository = `https://huggingface.co/${repo}`
	const pieces = manifest.shards.map(shard => `${shard.file} (SHA-256 ${shard.sha256})`).join(", ")
	const origin =
		manifest.whole === undefined
			? `Its weights are the GGUF files from ${repository} at revision ${revision}, served unmodified from Filen's model host: ${pieces}.`
			: `Its weights are the GGUF file from ${repository} at revision ${revision} (SHA-256 ${manifest.whole.sha256}), served unmodified from Filen's model host as ${manifest.whole.file}, and split by llama-gguf-split, without changing any tensor, into the pieces the app downloads: ${pieces}.`

	return vendoredNotice(
		{
			name: manifest.label,
			version: revision.slice(0, 7),
			license: manifest.license.name,
			copyright,
			repository,
			terms: [
				[
					`The language model the assistant runs on the device, licensed under ${manifest.license.name}; the license text below is the one published at ${manifest.license.url}.`,
					origin
				].join(" "),
				text
			]
		},
		"vendored"
	)
}

/**
 * The third-party material @filen/office brings into the app, read from the records that package keeps:
 *
 * - The document fonts the app serves at /office/fonts/ (vite/office-fonts-plugin.ts), from
 *   assets/fonts/manifest.json, each family with its own licence file and the record THIRD_PARTY_NOTICES.md
 *   keeps of it (its per-file hash list left to the manifest, which the notice already names the files from).
 * - Code derived from other projects, from THIRD_PARTY_NOTICES.md. This table names its sections, how to
 *   read a version off each section's Source line, and the licence text that applies; everything else,
 *   the notice texts included, is read from that file. AGPL-3.0 is the repository's own LICENSE.
 */
const OFFICE_DIR = "node_modules/@filen/office"
const OFFICE_FONTS = `${OFFICE_DIR}/assets/fonts`
const OFFICE_FONTS_MANIFEST = `${OFFICE_FONTS}/manifest.json`
const OFFICE_NOTICES = `${OFFICE_DIR}/THIRD_PARTY_NOTICES.md`
const OFFICE_REPO_DIR = "packages/filen-office"

interface NoticeSection {
	body: string
	fence: string | null
}

const OFFICE_DERIVED: {
	section: string
	name: string
	version: RegExp
	license: string
	text: (sections: Map<string, NoticeSection>) => string | readonly string[]
}[] = [
	{
		section: "SuperDoc 1.x",
		name: "SuperDoc",
		version: /^SuperDoc v(\d+\.\d+\.\d+) /,
		license: "AGPL-3.0",
		text: () => readFileSync("../../LICENSE", "utf8")
	},
	{
		section: "docx-preview (docxjs)",
		name: "docx-preview",
		version: /^docx-preview (\d+\.\d+\.\d+) /,
		license: "Apache-2.0",
		text: sections => noticeFence(sections, "Apache License 2.0")
	},
	{
		section: "ECMA-376 preset shape definitions",
		name: "ECMA-376 preset shape definitions",
		version: /^ECMA-376 Part 1, (\S+ edition) /,
		license: "LicenseRef-Ecma-Copyright-Notice",
		text: sections => noticeFence(sections, "ECMA-376 preset shape definitions")
	},
	{
		section: "[MS-DOC] Word (.doc) Binary File Format",
		name: "[MS-DOC] Word (.doc) Binary File Format",
		version: /^\[MS-DOC\] (v\d+) /,
		license: "LicenseRef-Microsoft-Open-Specifications-IP-Notice",
		text: sections => noticeFence(sections, "[MS-DOC] Word (.doc) Binary File Format")
	},
	{
		section: "[MS-ODRAW] Office Drawing Binary File Format",
		name: "[MS-ODRAW] Office Drawing Binary File Format",
		version: /^\[MS-ODRAW\] (v\d+) /,
		license: "LicenseRef-Microsoft-Open-Specifications-IP-Notice",
		text: sections => noticeFence(sections, "[MS-ODRAW] Office Drawing Binary File Format")
	},
	{
		section: "[MS-PPT] PowerPoint (.ppt) Binary File Format",
		name: "[MS-PPT] PowerPoint (.ppt) Binary File Format",
		version: /^\[MS-PPT\] (v\d+) /,
		license: "LicenseRef-Microsoft-Open-Specifications-IP-Notice",
		text: sections => noticeFence(sections, "[MS-PPT] PowerPoint (.ppt) Binary File Format")
	},
	{
		section: "Unicode symbol-font mappings",
		name: "Unicode symbol-font mappings",
		version: / of (\d{4}-\d{2}-\d{2}) /,
		license: "LicenseRef-Unicode-Mapping-Notice AND LicenseRef-Unicode-Terms-Of-Use",
		text: sections => noticeFences(sections, "Unicode symbol-font mappings")
	},
	{
		section: "Metafile symbol-font supplements",
		name: "Metafile symbol-font supplements",
		version: / version (c\d+) /,
		license: "LicenseRef-Apple-Mapping-Disclaimer AND CC-BY-SA-4.0",
		text: sections => noticeFences(sections, "Metafile symbol-font supplements")
	},
	{
		section: "CodeMirror highlight styles",
		name: "CodeMirror highlight styles",
		version: /@codemirror\/theme-one-dark (\d+\.\d+\.\d+) /,
		license: "MIT",
		text: sections => noticeFence(sections, "CodeMirror highlight styles")
	},
	{
		section: "LibreOffice locale data",
		name: "LibreOffice locale data",
		version: /^LibreOffice (\d+\.\d+\.\d+\.\d+) /,
		license: "MPL-2.0 AND Apache-2.0",
		text: sections => [noticeFence(sections, "LibreOffice locale data"), noticeFence(sections, "Apache License 2.0")]
	},
	{
		section: "pdf.js",
		name: "pdf.js",
		version: /^pdfjs-dist (\d+\.\d+\.\d+), /,
		license: "Apache-2.0",
		text: sections => noticeFence(sections, "Apache License 2.0")
	},
	{
		section: "HarfBuzz",
		name: "HarfBuzz",
		version: /^HarfBuzz (\d+\.\d+\.\d+) /,
		license: "MIT-Modern-Variant",
		text: sections => noticeFence(sections, "HarfBuzz")
	},
	{
		section: "Unicode Character Database (text shaping)",
		name: "Unicode Character Database",
		version: /^the Unicode Character Database (\d+\.\d+\.\d+) /,
		license: "Unicode-3.0",
		text: sections => noticeFence(sections, "Unicode Character Database (text shaping)")
	}
]

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${path}: expected an object`)
	}

	return Object.fromEntries(Object.entries(value))
}

const OFFICE_FONTS_SECTION = "Bundled fonts (SIL Open Font License 1.1)"

/**
 * The fonts section of THIRD_PARTY_NOTICES.md: its preamble, and one record per family keyed by its
 * `#### <name> <version>` heading. `take` hands a family's record out once; `rest` names any the
 * manifest did not claim, so a family recorded there but not shipped (or the reverse) refuses the run.
 */
function officeFontRecords(): { preamble: string; take: (name: string, version: string) => string; rest: () => string[] } {
	const { body } = noticeSection(noticeSections(), OFFICE_FONTS_SECTION)
	const clean = (text: string) =>
		text
			.replace(/^### [\s\S]*$/m, "")
			.replace(/^- Files\b[^\n]*\n(?: {2}[^\n]*(?:\n|$))*/m, "")
			.replaceAll("`", "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	const [head = "", ...chunks] = body.split(/^#### /m)
	const records = new Map(
		chunks.map(chunk => {
			const newline = chunk.indexOf("\n")

			return [chunk.slice(0, newline).trim(), clean(chunk.slice(newline + 1))] as const
		})
	)

	return {
		preamble: `${OFFICE_REPO_DIR}/THIRD_PARTY_NOTICES.md records the fonts @filen/office bundles as:\n${clean(head)}`,
		take: (name, version) => {
			const heading = `${name} ${version}`
			const record = records.get(heading)

			if (record === undefined) {
				throw new Error(`${OFFICE_NOTICES}: section "${OFFICE_FONTS_SECTION}" has no record "${heading}"`)
			}

			records.delete(heading)

			return `${OFFICE_REPO_DIR}/THIRD_PARTY_NOTICES.md records ${heading} as:\n${record}`
		},
		rest: () => [...records.keys()]
	}
}

function officeFontNotices(fonts: ReturnType<typeof officeFontRecords>): Collected[] {
	const families = requireJson(OFFICE_FONTS_MANIFEST)["families"]

	if (!Array.isArray(families) || families.length === 0) {
		throw new Error(`${OFFICE_FONTS_MANIFEST}: "families" is missing`)
	}

	return families.map(value => {
		const family = asRecord(value, OFFICE_FONTS_MANIFEST)
		const name = stringField(family, "name", OFFICE_FONTS_MANIFEST)
		const source = stringField(family, "source", OFFICE_FONTS_MANIFEST)
		const faces = family["faces"]

		if (!Array.isArray(faces) || faces.length === 0) {
			throw new Error(`${OFFICE_FONTS_MANIFEST}: ${name} has no faces`)
		}

		const records = faces.map(face => asRecord(face, OFFICE_FONTS_MANIFEST))
		const conversions = new Set(
			records.flatMap(face => {
				const conversion =
					face["upstream"] === undefined ? undefined : asRecord(face["upstream"], OFFICE_FONTS_MANIFEST)["conversion"]

				return typeof conversion === "string" ? [conversion] : []
			})
		)
		const license = splitCopyright(readFileSync(`${OFFICE_FONTS}/${stringField(family, "licenseFile", OFFICE_FONTS_MANIFEST)}`, "utf8"))
		const version = stringField(family, "version", OFFICE_FONTS_MANIFEST)

		return vendoredNotice(
			{
				name,
				version,
				license: stringField(family, "license", OFFICE_FONTS_MANIFEST),
				copyright: license.copyright,
				repository: source,
				terms: [
					[
						`The ${name} typeface, ${source} at commit ${stringField(family, "commit", OFFICE_FONTS_MANIFEST)}, used in place of ${stringField(family, "replaces", OFFICE_FONTS_MANIFEST)} when documents are displayed.`,
						`Bundled by @filen/office (${OFFICE_REPO_DIR}/assets/fonts in the filen-ts repository, ${FILEN_TS_REPOSITORY}) and served with the app as ${records.map(face => stringField(face, "file", OFFICE_FONTS_MANIFEST)).join(", ")}.`,
						...conversions,
						...pdfFaceTerms(family)
					].join(" "),
					fonts.take(name, version),
					fonts.preamble,
					license.terms
				]
			},
			"vendored"
		)
	})
}

/** The TrueType faces a family (or a fallback family) has for PDF export, and how each was made from upstream. */
function pdfFaceTerms(family: Record<string, unknown>): string[] {
	const pdf = family["pdf"]

	if (pdf === undefined) {
		return []
	}

	if (!Array.isArray(pdf) || pdf.length === 0) {
		throw new Error(`${OFFICE_FONTS_MANIFEST}: "pdf" of ${String(family["id"])} is malformed`)
	}

	const records = pdf.map(face => asRecord(face, OFFICE_FONTS_MANIFEST))
	const conversions = new Set(records.map(face => stringField(face, "conversion", OFFICE_FONTS_MANIFEST)))

	return [
		`Embedded, as glyph subsets, in PDF files the app exports, from ${records.map(face => stringField(face, "file", OFFICE_FONTS_MANIFEST)).join(", ")}, fetched only when a PDF is exported.`,
		...conversions
	]
}

/** The Noto families PDF export falls back to for scripts, symbols and math operators the bundled families lack. */
function officeFallbackFontNotices(fonts: ReturnType<typeof officeFontRecords>): Collected[] {
	const fallbacks = requireJson(OFFICE_FONTS_MANIFEST)["fallbacks"]

	if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
		throw new Error(`${OFFICE_FONTS_MANIFEST}: "fallbacks" is missing`)
	}

	return fallbacks.map(value => {
		const family = asRecord(value, OFFICE_FONTS_MANIFEST)
		const name = stringField(family, "name", OFFICE_FONTS_MANIFEST)
		const source = stringField(family, "source", OFFICE_FONTS_MANIFEST)
		const faces = family["faces"]

		if (!Array.isArray(faces) || faces.length === 0) {
			throw new Error(`${OFFICE_FONTS_MANIFEST}: ${name} has no faces`)
		}

		const records = faces.map(face => asRecord(face, OFFICE_FONTS_MANIFEST))
		const conversions = new Set(records.map(face => stringField(face, "conversion", OFFICE_FONTS_MANIFEST)))
		const license = splitCopyright(readFileSync(`${OFFICE_FONTS}/${stringField(family, "licenseFile", OFFICE_FONTS_MANIFEST)}`, "utf8"))
		const version = stringField(family, "version", OFFICE_FONTS_MANIFEST)

		return vendoredNotice(
			{
				name,
				version,
				license: stringField(family, "license", OFFICE_FONTS_MANIFEST),
				copyright: license.copyright,
				repository: source,
				terms: [
					[
						`The ${name} typeface, ${source}, embedded as glyph subsets in PDF files the app exports when their text has a script, symbols or math operators the bundled typefaces lack.`,
						`Bundled by @filen/office (${OFFICE_REPO_DIR}/assets/fonts in the filen-ts repository, ${FILEN_TS_REPOSITORY}) and served with the app as ${records.map(face => stringField(face, "file", OFFICE_FONTS_MANIFEST)).join(", ")}, fetched only when needed.`,
						...conversions
					].join(" "),
					fonts.take(name, version),
					fonts.preamble,
					license.terms
				]
			},
			"vendored"
		)
	})
}

/**
 * The hyphenation patterns the app serves at /office/hyphenation/ (vite/office-hyphenation-plugin.ts), one entry per
 * language from assets/hyphenation/manifest.json: its copyright and the licence block of its own header, verbatim,
 * and the record THIRD_PARTY_NOTICES.md keeps (with the MIT text the MIT-licensed files name).
 */
const OFFICE_HYPHENATION_MANIFEST = `${OFFICE_DIR}/assets/hyphenation/manifest.json`
const OFFICE_HYPHENATION_SECTION = "Hyphenation patterns (hyph-utf8)"

function officeHyphenationNotices(): Collected[] {
	const manifest = requireJson(OFFICE_HYPHENATION_MANIFEST)
	const commit = stringField(manifest, "commit", OFFICE_HYPHENATION_MANIFEST)
	const source = stringField(manifest, "source", OFFICE_HYPHENATION_MANIFEST)
	const languages = manifest["languages"]
	const sections = noticeSections()
	const record = noticeSection(sections, OFFICE_HYPHENATION_SECTION)
		.body.replace(/^```\n[\s\S]*?\n```$/gm, "")
		.replaceAll("`", "")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
	const mit = noticeFence(sections, OFFICE_HYPHENATION_SECTION)

	if (!Array.isArray(languages) || languages.length === 0) {
		throw new Error(`${OFFICE_HYPHENATION_MANIFEST}: "languages" is missing`)
	}

	return languages.map(value => {
		const language = asRecord(value, OFFICE_HYPHENATION_MANIFEST)
		const name = stringField(language, "name", OFFICE_HYPHENATION_MANIFEST)
		const license = stringField(language, "licence", OFFICE_HYPHENATION_MANIFEST)

		return vendoredNotice(
			{
				name: `hyph-utf8 ${name} hyphenation patterns`,
				version: commit.slice(0, 12),
				license,
				copyright: [stringField(language, "copyright", OFFICE_HYPHENATION_MANIFEST)],
				repository: source,
				terms: [
					`The ${name} hyphenation patterns of hyph-utf8, ${source} at commit ${commit}, served with the app as ${stringField(language, "file", OFFICE_HYPHENATION_MANIFEST)} by @filen/office (${OFFICE_REPO_DIR}/assets/hyphenation in the filen-ts repository, ${FILEN_TS_REPOSITORY}) to hyphenate documents.`,
					`${OFFICE_REPO_DIR}/THIRD_PARTY_NOTICES.md records the hyphenation patterns as:\n${record}`,
					stringField(language, "licenceText", OFFICE_HYPHENATION_MANIFEST),
					...(license === "MIT" ? [mit] : [])
				]
			},
			"vendored"
		)
	})
}

/** THIRD_PARTY_NOTICES.md by its level-2 headings: each section's prose and its first fenced block, verbatim. */
function noticeSections(): Map<string, NoticeSection> {
	const sections = new Map<string, NoticeSection>()

	for (const chunk of readFileSync(OFFICE_NOTICES, "utf8").split(/^## /m).slice(1)) {
		const newline = chunk.indexOf("\n")
		const body = chunk.slice(newline + 1)

		sections.set(chunk.slice(0, newline).trim(), { body, fence: /^```\n([\s\S]*?)\n```$/m.exec(body)?.[1] ?? null })
	}

	return sections
}

function noticeSection(sections: Map<string, NoticeSection>, heading: string): NoticeSection {
	const section = sections.get(heading)

	if (section === undefined) {
		throw new Error(`${OFFICE_NOTICES} has no section "${heading}"`)
	}

	return section
}

function noticeFence(sections: Map<string, NoticeSection>, heading: string): string {
	const fence = noticeSection(sections, heading).fence

	if (fence === null) {
		throw new Error(`${OFFICE_NOTICES}: section "${heading}" has no notice text`)
	}

	return fence
}

/** Every fenced block of a section (one per source whose notice the section reproduces), verbatim. */
function noticeFences(sections: Map<string, NoticeSection>, heading: string): readonly string[] {
	const fences = [...noticeSection(sections, heading).body.matchAll(/^```\n([\s\S]*?)\n```$/gm)].map(match => match[1] ?? "")

	if (fences.length === 0) {
		throw new Error(`${OFFICE_NOTICES}: section "${heading}" has no notice text`)
	}

	return fences
}

function officeDerivedNotices(): Collected[] {
	const sections = noticeSections()

	return OFFICE_DERIVED.map(entry => {
		const { body } = noticeSection(sections, entry.section)
		const field = (label: string) => {
			const value = new RegExp(`^- ${label}: (.+)$`, "m").exec(body)?.[1]

			if (value === undefined) {
				throw new Error(`${OFFICE_NOTICES}: section "${entry.section}" has no ${label}`)
			}

			return value
		}
		const source = field("Source")
		const version = entry.version.exec(source)?.[1]
		const repository = /(https:\/\/\S+)$/.exec(source)?.[1]

		if (version === undefined || repository === undefined) {
			throw new Error(`${OFFICE_NOTICES}: section "${entry.section}" names no version or URL in its Source`)
		}

		const record = body
			.replace(/^```\n[\s\S]*?\n```$/gm, "")
			.replace(/^- Copyright: .+\n/m, "")
			.replaceAll("`", "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()

		return vendoredNotice(
			{
				name: entry.name,
				version,
				license: entry.license,
				copyright: [`Copyright ${field("Copyright")}`],
				repository,
				terms: [
					`Code in @filen/office (${OFFICE_REPO_DIR} in the filen-ts repository, ${FILEN_TS_REPOSITORY}) derived from this work, as ${OFFICE_REPO_DIR}/THIRD_PARTY_NOTICES.md records it:\n${record}`,
					...[entry.text(sections)].flat()
				]
			},
			"vendored"
		)
	})
}

/**
 * The spellchecker @filen/spellcheck brings into the app:
 *
 * - The Rust crates its wasm engine is compiled from, read from that package's own Cargo.lock (its local
 *   cargo cache supplies the sources; run cargo fetch there first). Crates the SDK already lists are left
 *   to that entry.
 * - The Hunspell dictionaries the app serves (vite/spellcheck-assets-plugin.ts), from
 *   dictionaries/manifest.json: licence, holders, the modifications the build script made, and every
 *   licence and readme file shipped with the dictionary, verbatim.
 */
const SPELLCHECK_DIR = "node_modules/@filen/spellcheck"
const SPELLCHECK_LOCK = `${SPELLCHECK_DIR}/crate/Cargo.lock`
const SPELLCHECK_DICTIONARIES = `${SPELLCHECK_DIR}/dictionaries`
const SPELLCHECK_MANIFEST = `${SPELLCHECK_DICTIONARIES}/manifest.json`
const SPELLCHECK_REPO_DIR = "packages/filen-spellcheck"

function spellcheckCrateNotices(listed: readonly Collected[]): Collected[] {
	const known = new Set(listed.map(entry => `${entry.name}@${entry.version}`))
	const roots = crateSourceRoots()
	const entries: Collected[] = []

	for (const match of readFileSync(SPELLCHECK_LOCK, "utf8").matchAll(
		/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"(?:\nsource = "([^"]+)")?/g
	)) {
		const [, name, version, source] = match

		if (!source || !name || !version || known.has(`${name}@${version}`)) {
			continue
		}

		const dir = roots.map(root => join(root, `${name}-${version}`)).find(existsSync)

		if (dir === undefined) {
			throw new Error(`no local source for crate ${name}-${version} — run cargo fetch in ${SPELLCHECK_REPO_DIR}/crate`)
		}

		const entry = describeCargoCrate(name, version, dir)

		entries.push({
			...entry,
			terms: [
				`Compiled unmodified into the spellchecker's wasm module (${SPELLCHECK_REPO_DIR} in the filen-ts repository, ${FILEN_TS_REPOSITORY}); its source is the crates.io release ${name} ${version}.`,
				...entry.terms
			]
		})
	}

	return entries
}

// Notice files ship byte for byte as upstream wrote them; some are Latin-1.
function noticeText(path: string): string {
	const bytes = readFileSync(path)

	return isUtf8(bytes) ? bytes.toString("utf8") : bytes.toString("latin1")
}

function spellcheckDictionaryNotices(): Collected[] {
	const manifest = requireJson(SPELLCHECK_MANIFEST)
	const upstream = asRecord(manifest["upstream"], SPELLCHECK_MANIFEST)
	const repository = stringField(upstream, "repository", SPELLCHECK_MANIFEST)
	const commit = stringField(upstream, "commit", SPELLCHECK_MANIFEST)
	const dictionaries = manifest["dictionaries"]

	if (!Array.isArray(dictionaries) || dictionaries.length === 0) {
		throw new Error(`${SPELLCHECK_MANIFEST}: "dictionaries" is missing`)
	}

	return dictionaries.map(value => {
		const dictionary = asRecord(value, SPELLCHECK_MANIFEST)
		const id = stringField(dictionary, "id", SPELLCHECK_MANIFEST)
		const name = stringField(dictionary, "name", SPELLCHECK_MANIFEST)
		const upstreamVersion = dictionary["upstreamVersion"]
		const notices = dictionary["notices"]

		if (!Array.isArray(notices) || notices.length === 0) {
			throw new Error(`${SPELLCHECK_MANIFEST}: ${id} ships no notice files`)
		}

		const files = notices.map(notice => stringField(asRecord(notice, SPELLCHECK_MANIFEST), "file", SPELLCHECK_MANIFEST))

		return vendoredNotice(
			{
				name: `Hunspell dictionary ${name}`,
				version: typeof upstreamVersion === "string" ? upstreamVersion : `LibreOffice dictionaries ${commit.slice(0, 12)}`,
				license: stringField(dictionary, "license", SPELLCHECK_MANIFEST),
				copyright: stringsField(dictionary, "copyright", SPELLCHECK_MANIFEST),
				repository,
				terms: [
					[
						`The ${name} spelling dictionary (${id}) from ${repository} at commit ${commit}, as built by ${SPELLCHECK_REPO_DIR}/scripts/build-dictionaries.ts in the filen-ts repository (${FILEN_TS_REPOSITORY}), which publishes the modified files in ${SPELLCHECK_REPO_DIR}/dictionaries/${id}.`,
						`Modifications: ${stringsField(dictionary, "modifications", SPELLCHECK_MANIFEST).join("; ")}.`,
						`Served with the app under /assets/spellcheck/ and its notices under /spellcheck/dictionaries/${id}/.`
					].join(" "),
					...files.map(file => noticeText(`${SPELLCHECK_DICTIONARIES}/${file}`))
				]
			},
			"vendored"
		)
	})
}

const npm = collectNpm(installed)
const rust = collectRust(expectedSdk)
const ffmpeg = ffmpegModuleNotices()
const engine = wllamaEngineNotices()
const model = assistantModelNotice(QWEN35_4B)
const fontRecords = officeFontRecords()
const office = [
	...officeFontNotices(fontRecords),
	...officeFallbackFontNotices(fontRecords),
	...officeDerivedNotices(),
	...officeHyphenationNotices()
]

if (fontRecords.rest().length > 0) {
	throw new Error(`${OFFICE_NOTICES}: fonts recorded but not in ${OFFICE_FONTS_MANIFEST}: ${fontRecords.rest().join(", ")}`)
}
const spellcheckCrates = spellcheckCrateNotices(rust.entries)
const dictionaries = spellcheckDictionaryNotices()
const vendored = [...ffmpeg, ...engine, model, ...office, ...dictionaries]
const collected = [...npm, ...rust.entries, ...spellcheckCrates, ...vendored]

// Vendored entries promise their files verbatim (dictionaries ship them byte for byte). Texts sorted: the payload ships
// gzipped in the main bundle, and like texts side by side compress best.
const { texts, notices } = sortNoticeTexts(finalizeNotices(collected, entry => entry.ecosystem === "vendored"))

// No absolute path is ever written into the artifact: it is a committed source file, and a machine path
// would make regeneration produce a spurious diff on the next machine. The repository, the ref it was
// read at, and which candidate resolved carry the whole diagnostic value.
const output = `// AUTO-GENERATED by scripts/generateThirdPartyNotices.ts — do not edit.
//
// Attribution for everything bundled into the app: the npm tree minus dev/optional entries, the Rust
// crates the SDK wasm is built from, the components vendored as built output, and the assistant's model.
// License terms are deduplicated across packages and the copyright lines kept per package, so a rendered
// notice is that package's copyright followed by the verbatim terms. An empty \`texts\` means no license file shipped
// with the package; its SPDX id and repository are given instead rather than borrowing another package's
// copyright. More than one entry means the declared license is a conjunction — every text applies.
//
// npm:  pnpm licenses list --json --prod --no-optional --filter @filen/web... (${String(npm.length)} name@version packages)
// rust: filen-rs @ ${rust.ref} (${String(rust.crates)} crates)  [resolved via: ${rust.source}]
// vendored: ${ffmpeg.map(entry => `${entry.name} ${entry.version}`).join(", ")} (${FFMPEG_MANIFEST})
//   ${engine.map(entry => `${entry.name} ${entry.version}`).join(", ")} (${WLLAMA_MANIFEST})
//   assistant model: ${model.name} ${model.version} (${MODEL_MANIFEST_SOURCE})
//   @filen/office: ${office.map(entry => `${entry.name} ${entry.version}`).join(", ")} (${OFFICE_REPO_DIR}/assets/fonts/manifest.json, ${OFFICE_REPO_DIR}/THIRD_PARTY_NOTICES.md)
//   @filen/spellcheck: ${[...spellcheckCrates, ...dictionaries].map(entry => `${entry.name} ${entry.version}`).join(", ")} (${SPELLCHECK_REPO_DIR}/crate/Cargo.lock, ${SPELLCHECK_REPO_DIR}/dictionaries/manifest.json)
//
// Cannot run in CI: needs a filen-rs checkout and the local cargo caches. Re-run after any SDK bump.

export type ThirdPartyNotice = {
	name: string
	version: string
	license: string
	ecosystem: "npm" | "rust" | "vendored"
	copyright: string[]
	repository: string | null
	texts: number[]
}

export const THIRD_PARTY_NOTICES_SDK_VERSION = "${expectedSdk}"

export const THIRD_PARTY_NOTICES_FILEN_RS_REF = "${rust.ref}"

export const THIRD_PARTY_NOTICES_PAYLOAD = ${JSON.stringify(JSON.stringify({ texts, notices }))}
`

writeFileSync(OUTPUT, output, "utf8")

const withText = notices.filter(entry => entry.texts.length > 0).length

console.log(
	[
		`third-party notices -> ${OUTPUT}`,
		`  npm:            ${String(npm.length).padStart(4)}`,
		`  rust:           ${String(rust.entries.length).padStart(4)}  (${rust.ref}, via ${rust.source})`,
		`  spellcheck rust:${String(spellcheckCrates.length).padStart(4)}`,
		`  vendored:       ${String(vendored.length).padStart(4)}`,
		`  total:          ${String(notices.length)}`,
		`  license texts:  ${String(texts.length)} unique (deduplicated)`,
		`  with text:      ${String(withText)}`,
		`  without text:   ${String(notices.length - withText)}`,
		`  payload:        ${(Buffer.byteLength(output, "utf8") / 1024).toFixed(0)} KB`
	].join("\n")
)
