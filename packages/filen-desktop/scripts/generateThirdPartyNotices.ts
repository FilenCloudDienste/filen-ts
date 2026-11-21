import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import {
	crateSourceDir,
	crateSourceRoots,
	describeCargoCrate,
	describedNotice,
	describeLicensing,
	filenRsReleaseLock,
	finalizeNotices,
	gitIn,
	lockedCrates,
	npmPackageNotice,
	resolveFilenRsCheckout,
	sortNoticeTexts,
	splitCopyright,
	vendoredNotice,
	workspacePatches,
	type CollectedNotice
} from "@filen/shared/tooling"
import { BUILDER_OS } from "../src/shared/buildLayout.ts"
import { nodeLlamaCppDir } from "./bundles.ts"
import { backendPackages } from "./stageLlama.ts"
import { ARCHS, OS, pinnedRclone, rcloneRelease, readVersions } from "./stageRclone.ts"
import {
	bundledNpmPackages,
	DRAG_ADDON_LOCK,
	NODE_API_HEADERS,
	packageDir,
	readWebNotices,
	THIRD_PARTY_NOTICES_SOURCE,
	type DesktopNoticesFile,
	type NoticeEcosystem
} from "./thirdPartyNoticesSources.ts"

/**
 * Emits src/main/thirdPartyNotices.gen.json: the third-party notices for what the desktop app ships ON TOP of the
 * filen-web build it renders, whose own notices (filen-web's scripts/generateThirdPartyNotices.ts) the page always
 * shows. Main answers the page's notices dialog with this file and the page lists both.
 *
 * Licensing is described with filen-web's and filen-mobile's core (@filen/shared/tooling); see filen-web's generator
 * for the rules (copyright lines lifted, terms pooled, no license text ever borrowed). An entry filen-web already lists
 * at the same name and version is left to it. What desktop adds:
 *
 * - rust: the crates of the sync addon (@filen/sdk-rs's napi build, from the filen-rs workspace Cargo.lock at the
 *   release tag of the installed @filen/sdk-rs), of the macOS File Provider extension (the same lockfile at the commit
 *   desktop's filen-rs submodule pins) and of Explorer drag-out (native/dragOut/win/Cargo.lock).
 * - npm: the packages esbuild bundles (main, native host, preload, the assistant engine), plus the Node-API headers the
 *   Swift addons compile with.
 * - go: the Go modules linked into the bundled rclone, read from the build info of every pinned release binary, and the
 *   Go standard library at the toolchain version they were built with.
 * - vendored: Electron, the Chromium and Node.js it includes (their full credits ship as LICENSES.chromium.html, which
 *   electron-builder keeps in every package), rclone, the WinFsp installer bundled on Windows, and the assistant
 *   engine's prebuilt node-llama-cpp backends with the llama.cpp compiled into them.
 *
 * CANNOT RUN IN CI: it needs a filen-rs checkout, the local cargo caches (cargo fetch in the filen-rs checkout, at the
 * submodule's commit and in native/dragOut/win), Go on PATH and the network (rclone release zips, Go modules, the
 * WinFsp and Go license files). Re-run after any @filen/sdk-rs, filen-rs submodule, Electron, rclone, WinFsp or
 * bundled dependency change, and after filen-web's notices are regenerated; src/tests/thirdPartyNotices.test.ts fails
 * until it is.
 *
 * Run from the package root:
 *   node scripts/generateThirdPartyNotices.ts
 *   --filen-rs=<path>   filen-rs checkout to read the crate lockfiles from (else FILEN_RS_PATH, else ../filen-rs
 *                       beside filen-ts)
 */

type Collected = CollectedNotice<NoticeEcosystem>

const FILEN_TS_REPOSITORY = "https://github.com/FilenCloudDienste/filen-ts"
const WORKSPACE_FILE = path.join(packageDir, "..", "..", "pnpm-workspace.yaml")
const require = createRequire(import.meta.url)

function packageJson(dir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>
}

function stringOf(record: Record<string, unknown>, key: string, what: string): string {
	const value = record[key]

	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${what} has no ${key}`)
	}

	return value
}

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url)

	if (!response.ok) {
		throw new Error(`${url}: HTTP ${String(response.status)}`)
	}

	return response.text()
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const web = readWebNotices()
const listed = new Set(web.notices.map(notice => `${notice.ecosystem}:${notice.name}@${notice.version}`))
const collected: Collected[] = []

// filen-web's entries are the page's own list; one already there, or already added here, is not listed twice.
function add(entry: Collected): boolean {
	const key = `${entry.ecosystem}:${entry.name}@${entry.version}`

	if (listed.has(key)) {
		return false
	}

	listed.add(key)
	collected.push(entry)

	return true
}

// --- rust -------------------------------------------------------------------------------------------------------

const sdkDir = path.join(packageDir, "node_modules", "@filen", "sdk-rs")
const sdkVersion = stringOf(packageJson(sdkDir), "version", "@filen/sdk-rs")
const checkout = resolveFilenRsCheckout(path.join(packageDir, "..", "..", "..", "filen-rs"))
const napi = filenRsReleaseLock(checkout.path, sdkVersion, false)
const fileProviderCommit = gitIn(packageDir, ["rev-parse", "HEAD:./filen-rs"]).trim()
const roots = crateSourceRoots()
const rustSources: { label: string; lock: string; fetch: string }[] = [
	{ label: `sync addon (filen-rs ${napi.ref})`, lock: napi.lock, fetch: `cargo fetch in ${checkout.path} at ${napi.ref}` },
	{
		label: `File Provider extension (filen-rs ${fileProviderCommit.slice(0, 12)})`,
		lock: gitIn(checkout.path, ["show", `${fileProviderCommit}:Cargo.lock`]),
		fetch: `cargo fetch in a checkout of filen-rs at ${fileProviderCommit}`
	},
	{
		label: "Explorer drag-out (native/dragOut/win)",
		lock: readFileSync(DRAG_ADDON_LOCK, "utf8"),
		fetch: "cargo fetch in native/dragOut/win"
	}
]
const rustCounts = new Map<string, number>()

for (const { label, lock, fetch } of rustSources) {
	let added = 0

	for (const crate of lockedCrates(lock)) {
		if (listed.has(`rust:${crate.name}@${crate.version}`)) {
			continue
		}

		const dir = crateSourceDir(roots, crate)

		if (dir === undefined) {
			throw new Error(`no local source for crate ${crate.name}-${crate.version} (${label}) — run ${fetch}`)
		}

		added += add(describeCargoCrate(crate.name, crate.version, dir)) ? 1 : 0
	}

	rustCounts.set(label, added)
}

// --- npm --------------------------------------------------------------------------------------------------------

const patches = workspacePatches(WORKSPACE_FILE)
const nodeApiHeadersDir = path.dirname(require.resolve(`${NODE_API_HEADERS}/package.json`, { paths: [packageDir] }))
const npmPackages = [
	...(await bundledNpmPackages()),
	{ name: NODE_API_HEADERS, version: stringOf(packageJson(nodeApiHeadersDir), "version", NODE_API_HEADERS), dir: nodeApiHeadersDir }
]
let npmAdded = 0

for (const pkg of npmPackages) {
	const entry = npmPackageNotice(pkg, patches, FILEN_TS_REPOSITORY)

	if (entry === null) {
		throw new Error(`${pkg.name}@${pkg.version}: no readable package.json in ${pkg.dir}`)
	}

	npmAdded += add(entry) ? 1 : 0
}

// --- Electron, Chromium, Node.js ----------------------------------------------------------------------------------

const electronDir = path.dirname(require.resolve("electron/package.json", { paths: [packageDir] }))
const electronVersion = stringOf(packageJson(electronDir), "version", "electron")
const electronDist = path.join(electronDir, "dist")
const electronBinary = path.join(electronDist, readFileSync(path.join(electronDir, "path.txt"), "utf8").trim())
const runtime = JSON.parse(
	execFileSync(electronBinary, ["-p", "JSON.stringify({ chrome: process.versions.chrome, node: process.versions.node })"], {
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		encoding: "utf8"
	})
) as { chrome: string; node: string }
const credits = readFileSync(path.join(electronDist, "LICENSES.chromium.html"), "utf8")

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/g, "&")
}

// One product's license in Chromium's credits page, verbatim.
function creditsLicense(title: string): string {
	for (const match of credits.matchAll(/<div class="product">\s*<span class="title">([^<]*)<\/span>.*?<pre>(.*?)<\/pre>/gs)) {
		if (match[1] !== undefined && decodeEntities(match[1]) === title && match[2] !== undefined) {
			return decodeEntities(match[2])
		}
	}

	throw new Error(`LICENSES.chromium.html of Electron ${electronVersion} has no "${title}" entry`)
}

const CREDITS_POINTER = `Electron ${electronVersion} includes Chromium ${runtime.chrome} and Node.js ${runtime.node}. Their licenses, and those of every component they include, ship with this app in the file LICENSES.chromium.html: in Filen.app/Contents/Resources on macOS, and in the installation directory on Windows and Linux.`
const electronLicense = splitCopyright(readFileSync(path.join(electronDist, "LICENSE"), "utf8"))
const chromiumLicense = creditsLicense("The Chromium Project")
const chromiumHolder = /Copyright \d{4} The Chromium Authors/.exec(chromiumLicense)?.[0]
const nodeOwnLicense = /Node\.js is licensed for use as follows:\s*"""\n([\s\S]*?)\n"""/.exec(creditsLicense("Node.js"))?.[1]

if (chromiumHolder === undefined || nodeOwnLicense === undefined) {
	throw new Error(`LICENSES.chromium.html of Electron ${electronVersion} no longer has the shape this generator reads`)
}

const nodeLicense = splitCopyright(nodeOwnLicense)

add(
	vendoredNotice(
		{
			name: "Electron",
			version: electronVersion,
			license: "MIT",
			copyright: electronLicense.copyright,
			repository: "https://github.com/electron/electron",
			terms: [electronLicense.terms, CREDITS_POINTER]
		},
		"vendored"
	)
)
add(
	vendoredNotice(
		{
			name: "Chromium",
			version: runtime.chrome,
			license: "BSD-3-Clause",
			copyright: [chromiumHolder],
			repository: "https://source.chromium.org/chromium",
			terms: [chromiumLicense, CREDITS_POINTER]
		},
		"vendored"
	)
)
add(
	vendoredNotice(
		{
			name: "Node.js",
			version: runtime.node,
			license: "MIT",
			copyright: nodeLicense.copyright,
			repository: "https://github.com/nodejs/node",
			terms: [nodeLicense.terms, CREDITS_POINTER]
		},
		"vendored"
	)
)

// --- rclone and the Go modules linked into it ---------------------------------------------------------------------

const rcloneVersions = readVersions()
const rcloneTag = `v${rcloneVersions.rclone}`
const goModules = new Map<string, { path: string; version: string }>()
const goVersions = new Set<string>()
const rcloneBuilds: string[] = []
const scratch = mkdtempSync(path.join(tmpdir(), "filen-notices-"))

try {
	for (const platform of Object.keys(OS) as NodeJS.Platform[]) {
		for (const arch of ARCHS) {
			const release = rcloneRelease(arch, rcloneVersions, platform)
			const binary = path.join(scratch, "rclone")

			writeFileSync(binary, await pinnedRclone(arch, rcloneVersions, platform))

			// `go version -m`: the toolchain on the first line, then path / mod / dep / => (replacement) / build lines.
			const info = execFileSync("go", ["version", "-m", binary], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
			const toolchain = /^[^\n]*: go(\S+)$/m.exec(info)?.[1]

			if (toolchain === undefined || !/^\tmod\tgithub\.com\/rclone\/rclone\tv/m.test(info)) {
				throw new Error(`${release.url}: no Go build info for rclone`)
			}

			goVersions.add(toolchain)
			rcloneBuilds.push(`${path.basename(release.url)} (SHA-256 ${release.sha256})`)

			const lines = info.split("\n").map(line => line.split("\t"))

			lines.forEach((fields, index) => {
				if (fields[1] !== "dep" || fields[2] === undefined || fields[3] === undefined) {
					return
				}

				const replaced = lines[index + 1]
				const module =
					replaced?.[1] === "=>" && replaced[2] !== undefined && replaced[3] !== undefined
						? { path: replaced[2], version: replaced[3] }
						: { path: fields[2], version: fields[3] }

				goModules.set(`${module.path}@${module.version}`, module)
			})
		}
	}
} finally {
	rmSync(scratch, { recursive: true, force: true })
}

if (goVersions.size !== 1) {
	throw new Error(`rclone ${rcloneTag}'s release binaries were built with different Go toolchains: ${[...goVersions].join(", ")}`)
}

const [goVersion = ""] = goVersions

// Module sources from the Go module proxy, into the local module cache (go mod download, outside any module).
function goModuleDirs(modules: readonly string[]): Map<string, string> {
	const empty = mkdtempSync(path.join(tmpdir(), "filen-notices-go-"))

	try {
		const output = execFileSync("go", ["mod", "download", "-json", ...modules], {
			cwd: empty,
			env: { ...process.env, GOTOOLCHAIN: "local", GOFLAGS: "-modcacherw", GO111MODULE: "on" },
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024
		})
		const dirs = new Map<string, string>()

		for (const object of output.split(/\n(?=\{)/)) {
			const parsed = JSON.parse(object) as { Path: string; Version: string; Dir?: string; Error?: string }

			if (parsed.Dir === undefined) {
				throw new Error(`go mod download ${parsed.Path}@${parsed.Version}: ${parsed.Error ?? "no directory"}`)
			}

			dirs.set(`${parsed.Path}@${parsed.Version}`, parsed.Dir)
		}

		return dirs
	} finally {
		rmSync(empty, { recursive: true, force: true })
	}
}

/**
 * The SPDX ids a Go module's license texts state. Go modules declare no license, so it is read from the texts by the
 * operative sentence of each license; a text matching several (gopkg.in/yaml.v3 carries MIT and Apache-2.0) is a
 * conjunction. UNKNOWN when nothing matches, which the payload states rather than guesses.
 */
function goLicense(terms: readonly string[]): string {
	const found = new Set<string>()

	for (const text of terms) {
		const flat = text.replace(/\s+/g, " ")

		if (/Apache License,? Version 2\.0/i.test(flat)) found.add("Apache-2.0")
		if (/Mozilla Public License,? (Version|v\.?) ?2\.0/i.test(flat)) found.add("MPL-2.0")
		if (/Permission is hereby granted, free of charge/i.test(flat)) found.add("MIT")
		if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose/i.test(flat)) found.add("ISC")
		if (/This is free and unencumbered software released into the public domain/i.test(flat)) found.add("Unlicense")
		if (/CC0 1\.0 Universal/i.test(flat)) found.add("CC0-1.0")
		if (/GNU LESSER GENERAL PUBLIC LICENSE Version 3/i.test(flat)) found.add("LGPL-3.0-only")
		if (/GNU LESSER GENERAL PUBLIC LICENSE Version 2\.1/i.test(flat)) found.add("LGPL-2.1-only")
		if (/Redistribution and use in source and binary forms/i.test(flat)) {
			found.add(/Neither the name|names of its contributors may be used/i.test(flat) ? "BSD-3-Clause" : "BSD-2-Clause")
		}
	}

	return found.size === 0 ? "UNKNOWN" : [...found].sort().join(" AND ")
}

const goDirs = goModuleDirs([`github.com/rclone/rclone@${rcloneTag}`, ...goModules.keys()])
const rcloneDir = goDirs.get(`github.com/rclone/rclone@${rcloneTag}`)

if (rcloneDir === undefined) {
	throw new Error(`go mod download returned no github.com/rclone/rclone@${rcloneTag}`)
}

const unknownGo: string[] = []

for (const module of goModules.values()) {
	const dir = goDirs.get(`${module.path}@${module.version}`) ?? null
	// Read once to name the license, then described under it, so an Apache-2.0 module's NOTICE ships with its terms.
	const license = goLicense(describeLicensing(dir, "UNKNOWN").terms)

	if (license === "UNKNOWN") {
		unknownGo.push(`${module.path}@${module.version}`)
	}

	add(
		describedNotice({
			name: module.path,
			version: module.version,
			license,
			ecosystem: "go",
			dir,
			repository: `https://pkg.go.dev/${module.path}@${module.version}`
		})
	)
}

const goLicenseText = splitCopyright(await fetchText(`https://raw.githubusercontent.com/golang/go/go${goVersion}/LICENSE`))

add(
	vendoredNotice(
		{
			name: "Go standard library",
			version: goVersion,
			license: "BSD-3-Clause",
			copyright: goLicenseText.copyright,
			repository: `https://github.com/golang/go/tree/go${goVersion}`,
			terms: [`Linked into rclone ${rcloneTag}, which was built with Go ${goVersion}.`, goLicenseText.terms]
		},
		"vendored"
	)
)

const rcloneLicense = splitCopyright(readFileSync(path.join(rcloneDir, "COPYING"), "utf8"))

add(
	vendoredNotice(
		{
			name: "rclone",
			version: rcloneVersions.rclone,
			license: "MIT",
			copyright: rcloneLicense.copyright,
			repository: `https://github.com/rclone/rclone/tree/${rcloneTag}`,
			terms: [
				rcloneLicense.terms,
				`Bundled unmodified: the official rclone ${rcloneTag} release binaries, ${rcloneBuilds.join(", ")}, from https://downloads.rclone.org/${rcloneTag}/. The Go modules linked into them are listed with their own licenses.`
			]
		},
		"vendored"
	)
)

// --- WinFsp -------------------------------------------------------------------------------------------------------

const winfspTag = /\/releases\/download\/([^/]+)\//.exec(rcloneVersions.winfspUrl)?.[1]

if (winfspTag === undefined) {
	throw new Error(`build/rclone/versions.json: no release tag in ${rcloneVersions.winfspUrl}`)
}

const winfspLicense = await fetchText(`https://raw.githubusercontent.com/winfsp/winfsp/${winfspTag}/License.txt`)
// The FLOSS exception asks for exactly this notice and a link to the repository in the user interface.
const WINFSP_NOTICE = "WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos"

if (!winfspLicense.replace(/\s+/g, " ").includes(`"${WINFSP_NOTICE}"`)) {
	throw new Error(`WinFsp ${winfspTag}'s License.txt no longer asks for the notice "${WINFSP_NOTICE}"; re-read its terms`)
}

add(
	vendoredNotice(
		{
			name: "WinFsp",
			version: rcloneVersions.winfsp,
			license: "GPL-3.0-only WITH WinFsp-FLOSS-exception",
			copyright: [WINFSP_NOTICE],
			repository: "https://github.com/winfsp/winfsp",
			terms: [
				winfspLicense.trim(),
				`Bundled unmodified on Windows: the WinFsp installer ${path.basename(new URL(rcloneVersions.winfspUrl).pathname)} (SHA-256 ${rcloneVersions.winfspSha256}) as released by the WinFsp project at ${rcloneVersions.winfspUrl}, which this app's installer runs. Its source is https://github.com/winfsp/winfsp/tree/${winfspTag}.`
			]
		},
		"vendored"
	)
)

// --- the assistant engine: llama.cpp and node-llama-cpp's prebuilt backends -------------------------------------------

// node-llama-cpp's own code is bundled (npm, above); its prebuilt backends ship as published (scripts/stageLlama.ts),
// every one for the OSes and CPUs the app builds for, and are llama.cpp compiled at the release node-llama-cpp names.
const llamaDir = nodeLlamaCppDir()
const llamaVersion = stringOf(packageJson(llamaDir), "version", "node-llama-cpp")
const llamaCpp = JSON.parse(readFileSync(path.join(llamaDir, "llama", "llama.cpp.info.json"), "utf8")) as {
	tag: string
	llamaCppGithubRepo: string
}
const optional = Object.keys((packageJson(llamaDir)["optionalDependencies"] ?? {}) as Record<string, string>)
const published = optional.map(name => name.replace("@node-llama-cpp/", ""))
const backendNames = [
	...new Set(ARCHS.flatMap(arch => Object.values(BUILDER_OS).flatMap(os => backendPackages(published, os, arch))))
].sort()
const backendLicenses = new Map<string, string>()

for (const name of backendNames) {
	backendLicenses.set(name, await fetchText(`https://unpkg.com/@node-llama-cpp/${name}@${llamaVersion}/LICENSE`))
}

const backendLicense = [...new Set(backendLicenses.values())]

if (backendLicense.length !== 1 || backendLicense[0] === undefined) {
	throw new Error(`node-llama-cpp ${llamaVersion}'s prebuilt backends no longer share one license; list them one by one`)
}

const backendTerms = splitCopyright(backendLicense[0])

add(
	vendoredNotice(
		{
			name: "node-llama-cpp prebuilt backends",
			version: llamaVersion,
			license: "MIT",
			copyright: backendTerms.copyright,
			repository: "https://github.com/withcatai/node-llama-cpp",
			terms: [
				backendTerms.terms,
				`Bundled unmodified for the assistant's on-device model, each on the systems it is built for: ${backendNames.map(name => `@node-llama-cpp/${name}@${llamaVersion}`).join(", ")}.`
			]
		},
		"vendored"
	)
)

const llamaCppLicense = splitCopyright(
	await fetchText(`https://raw.githubusercontent.com/${llamaCpp.llamaCppGithubRepo}/${llamaCpp.tag}/LICENSE`)
)

add(
	vendoredNotice(
		{
			name: "llama.cpp",
			version: llamaCpp.tag,
			license: "MIT",
			copyright: llamaCppLicense.copyright,
			repository: `https://github.com/${llamaCpp.llamaCppGithubRepo}`,
			terms: [
				llamaCppLicense.terms,
				`Compiled into node-llama-cpp ${llamaVersion}'s prebuilt backends (the ggml and llama libraries, with their Metal, Vulkan and CPU code), from https://github.com/${llamaCpp.llamaCppGithubRepo}/tree/${llamaCpp.tag}.`
			]
		},
		"vendored"
	)
)

// --- payload ------------------------------------------------------------------------------------------------------

// Vendored entries keep their texts byte for byte.
const { texts, notices } = sortNoticeTexts(finalizeNotices(collected, entry => entry.ecosystem === "vendored"))
const file: DesktopNoticesFile = {
	generated: {
		sdkVersion,
		filenRsRef: napi.ref,
		web: { sdkVersion: web.sdkVersion, filenRsRef: web.filenRsRef },
		fileProviderFilenRs: fileProviderCommit,
		electron: electronVersion,
		chromium: runtime.chrome,
		node: runtime.node,
		rclone: rcloneVersions.rclone,
		go: goVersion,
		winfsp: rcloneVersions.winfsp
	},
	texts,
	notices
}
const output = `${JSON.stringify(file, null, "\t")}\n`

writeFileSync(THIRD_PARTY_NOTICES_SOURCE, output, "utf8")

const count = (ecosystem: NoticeEcosystem) => notices.filter(notice => notice.ecosystem === ecosystem).length

console.log(
	[
		`desktop third-party notices -> ${path.relative(packageDir, THIRD_PARTY_NOTICES_SOURCE)} (beyond filen-web's ${String(web.notices.length)}, ${web.filenRsRef})`,
		...[...rustCounts].map(([label, added]) => `  rust ${label}: ${String(added)}`),
		`  npm (bundled, Node-API headers): ${String(npmAdded)} of ${String(npmPackages.length)}`,
		`  go (rclone ${rcloneTag}, Go ${goVersion}): ${String(count("go"))}${unknownGo.length > 0 ? `, license UNKNOWN: ${unknownGo.join(", ")}` : ""}`,
		`  vendored: ${notices
			.filter(notice => notice.ecosystem === "vendored")
			.map(notice => `${notice.name} ${notice.version}`)
			.join(", ")}`,
		`  total: ${String(notices.length)}, ${String(texts.length)} unique texts, ${String(notices.filter(notice => notice.texts.length === 0).length)} without text`,
		`  WinFsp License.txt sha256 ${sha256(winfspLicense)}`,
		`  payload: ${(Buffer.byteLength(output, "utf8") / 1024).toFixed(0)} KB`
	].join("\n")
)
