import { isUtf8 } from "node:buffer"
import { readFileSync } from "node:fs"
import { beforeAll, describe, expect, it } from "vitest"
import { listInstalledNpm, type InstalledNpmPackage } from "@filen/shared/tooling"
import {
	filterThirdPartyNotices,
	findThirdPartyNotice,
	thirdPartyLicenseTexts,
	thirdPartyNoticesPayload,
	THIRD_PARTY_NOTICES_FILEN_RS_REF,
	THIRD_PARTY_NOTICES_SDK_VERSION
} from "@/features/settings/lib/thirdPartyNotices"
import { noticeRepositoryHref } from "@/features/settings/components/advanced/thirdPartyNoticesDialog.logic"
import ffmpegManifest from "@/vendor/ffmpeg-decoders/manifest.json"
import libopenmptManifest from "@/vendor/libopenmpt/manifest.json"
import wllamaManifest from "@/vendor/wllama/manifest.json"
import officeFontsManifest from "@filen/office/assets/fonts/manifest.json"
import spellcheckManifest from "@filen/spellcheck/dictionaries/manifest.json"

const { notices: THIRD_PARTY_NOTICES, texts: LICENSE_TEXTS } = thirdPartyNoticesPayload()

/**
 * The notices payload discharges a legal obligation, so the failure that matters is a SILENT one: a
 * dependency added or bumped without re-running scripts/generateThirdPartyNotices.ts leaves the shipped
 * attribution describing a tree the app no longer has, and nothing about the app misbehaves.
 *
 * The generator cannot run in CI (it needs a filen-rs checkout and the local cargo caches), so every
 * guard here reads what CI does have: the committed payload and the installed pnpm tree.
 */
let installed: InstalledNpmPackage[]
let lockIds: Set<string>
let lockEntries: number

// The same query the generator runs, identified as `name@version`, so the two sides of the comparison
// cannot drift apart. The spawn is the slow part of this file; run it in a hook whose timeout actually
// covers it.
beforeAll(() => {
	installed = listInstalledNpm("@filen/web")
	lockIds = new Set(installed.map(entry => `${entry.name}@${entry.version}`))
	lockEntries = installed.length
}, 60_000)

const payloadNpmIds = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "npm").map(n => `${n.name}@${n.version}`))
const BUILD_ONLY = ["vitest", "eslint", "prettier", "typescript"]

/** Names the installed tree holds at two or more distinct versions — computed, never hardcoded. */
function multiVersionNames(): string[] {
	const versions = new Map<string, Set<string>>()

	for (const id of lockIds) {
		const at = id.lastIndexOf("@")
		const name = id.slice(0, at)
		const seen = versions.get(name) ?? new Set<string>()

		seen.add(id.slice(at + 1))
		versions.set(name, seen)
	}

	return [...versions].filter(([, seen]) => seen.size > 1).map(([name]) => name)
}

describe("third-party notices drift guard", () => {
	it("covers exactly the installed npm packages that ship", () => {
		// The drift guard, and the reason this file exists: add, remove or bump a runtime dependency without
		// re-running the generator and this fails, naming what went missing or appeared. No tolerance.
		expect([...lockIds].filter(id => !payloadNpmIds.has(id)).sort(), "missing from the payload — re-run the generator").toEqual([])
		expect([...payloadNpmIds].filter(id => !lockIds.has(id)).sort(), "in the payload but not installed — run pnpm install").toEqual([])
	})

	it("lists every peer of the workspace packages the app compiles from source", () => {
		// Workspace packages ship as source, so the app bundles their peers. pnpm reports a package only along
		// `dependencies` edges, so a peer the app does not declare itself still bundles (from the workspace
		// package's own dev copy) and silently drops out of the attribution.
		interface Manifest {
			dependencies?: Record<string, string>
			peerDependencies?: Record<string, string>
		}

		const manifest = (url: URL): Manifest => JSON.parse(readFileSync(url, "utf8")) as Manifest
		const workspaceDeps = (deps: Record<string, string> | undefined) =>
			Object.entries(deps ?? {})
				.filter(([, spec]) => spec.startsWith("workspace:"))
				.map(([name]) => name)
		const queue = workspaceDeps(manifest(new URL("../../package.json", import.meta.url)).dependencies)
		const visited = new Set<string>()
		const peers = new Set<string>()

		for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
			if (visited.has(name)) {
				continue
			}

			visited.add(name)

			const workspace = manifest(new URL(`../../node_modules/${name}/package.json`, import.meta.url))

			for (const peer of Object.keys(workspace.peerDependencies ?? {})) {
				peers.add(peer)
			}

			queue.push(...workspaceDeps(workspace.dependencies))
		}

		expect(visited.has("@filen/office")).toBe(true)
		expect([...peers].filter(peer => ![...lockIds].some(id => id.startsWith(`${peer}@`))).sort()).toEqual([])
	})

	it("was generated against the installed SDK", () => {
		// Turns three previously-silent failures red: generating from the wrong filen-rs checkout, merging a
		// payload built before an SDK bump, and any future bump that forgets to re-run the generator.
		expect(THIRD_PARTY_NOTICES_SDK_VERSION, `payload ref ${THIRD_PARTY_NOTICES_FILEN_RS_REF}`).toBe(
			installed.find(entry => entry.name === "@filen/sdk-rs")?.version
		)
	})

	it("reads a well-formed, non-empty id set from the installed tree", () => {
		expect(lockIds.size).toBeGreaterThan(0)
		expect([...lockIds].filter(id => !/^(@[^/]+\/)?[^/@]+@\S+$/.test(id)).sort()).toEqual([])
	})

	it("excludes build-only tooling from the id set", () => {
		// The cheap proof the dev filter actually ran on this side of the comparison.
		expect(BUILD_ONLY.filter(name => [...lockIds].some(id => id.startsWith(`${name}@`))).sort()).toEqual([])
	})

	it("includes a known shipping package at the version pnpm states", () => {
		const react = installed.find(entry => entry.name === "react")?.version

		expect(typeof react).toBe("string")
		expect(lockIds.has(`react@${String(react)}`)).toBe(true)
	})

	it("collapses reported entries that share an id", () => {
		// One id can be reported more than once; the payload holds a single entry per id.
		expect(lockIds.size).toBeLessThanOrEqual(lockEntries)
	})

	it("keeps every version of a package that is installed twice", () => {
		const names = multiVersionNames()

		// Skips rather than fails if a future dedupe removes every collision — the guard is the payload
		// matching the installed tree, not this tree happening to have multi-version packages.
		for (const name of names) {
			for (const id of [...lockIds].filter(candidate => candidate.startsWith(`${name}@`))) {
				expect(payloadNpmIds.has(id), `${id} missing from the payload`).toBe(true)
			}
		}
	})
})

describe("third-party notices honesty", () => {
	it("never lends a holder-bearing license to a package that shipped none", () => {
		// Apache-2.0's file carries no holder (its appendix is a placeholder), so one canonical copy may
		// serve every package that elected it. An MIT/BSD file IS its holder and may never be lent.
		const apacheIndices = LICENSE_TEXTS.map((text, index) => ({ text, index })).filter(
			({ text }) =>
				text.trimStart().startsWith("Apache License") && text.includes("APPENDIX: How to apply the Apache License to your work")
		)

		expect(apacheIndices.length).toBeGreaterThan(0)

		for (const { index } of apacheIndices) {
			const borrowers = THIRD_PARTY_NOTICES.filter(notice => notice.texts.includes(index) && !/apache/i.test(notice.license))

			expect(borrowers.map(notice => `${notice.name}@${notice.version}`).sort()).toEqual([])
		}
	})

	it("does not borrow a copyright for a package that shipped no license file", () => {
		const borrowed = THIRD_PARTY_NOTICES.filter(notice => notice.texts.length === 0 && notice.copyright.length > 0)

		expect(borrowed.map(notice => `${notice.name}@${notice.version}`).sort()).toEqual([])
	})

	it("never lifts a license template's placeholder as a copyright holder", () => {
		const placeholders = THIRD_PARTY_NOTICES.filter(notice =>
			notice.copyright.some(line => /\[yyyy\]|\[name of copyright owner\]|<year>|<name of author>/i.test(line))
		)

		expect(placeholders.map(notice => `${notice.name}@${notice.version}`).sort()).toEqual([])
	})

	it("excludes build-only tooling from the payload", () => {
		// Paired with the id-set case above: together they prove the dev filter ran on BOTH sides rather
		// than that two identical mistakes cancelled out.
		expect(BUILD_ONLY.filter(name => THIRD_PARTY_NOTICES.some(notice => notice.name === name)).sort()).toEqual([])
	})
})

describe("third-party notices payload integrity", () => {
	it("resolves every text index", () => {
		const outOfRange = THIRD_PARTY_NOTICES.filter(notice => notice.texts.some(index => index < 0 || index >= LICENSE_TEXTS.length))

		expect(outOfRange.map(notice => notice.name).sort()).toEqual([])
	})

	it("names and versions every entry", () => {
		const nameless = THIRD_PARTY_NOTICES.filter(notice => notice.name.length === 0 || notice.version.length === 0)

		expect(nameless.length).toBe(0)
	})

	it("keys every entry uniquely, as the virtualizer requires", () => {
		const keys = THIRD_PARTY_NOTICES.map(notice => `${notice.ecosystem}:${notice.name}@${notice.version}`)

		expect(new Set(keys).size).toBe(keys.length)
	})

	it("describes every source that ships", () => {
		expect([...new Set(THIRD_PARTY_NOTICES.map(notice => notice.ecosystem))].sort()).toEqual(["npm", "rust", "vendored"])
	})

	it("describes the vendored FFmpeg build as its manifest records it", () => {
		// The manifest is rewritten by every decoder build; a rebuild with another release or other flags
		// that skips the generator fails here.
		const ffmpeg = THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "vendored" && notice.name === "FFmpeg")

		expect(ffmpeg.map(notice => notice.version)).toEqual([ffmpegManifest.ffmpeg.tag.replace(/^n/, "")])

		const [notice] = ffmpeg
		const terms = notice === undefined ? [] : thirdPartyLicenseTexts(notice)
		const build = terms.find(text => text.includes(ffmpegManifest.ffmpeg.sha256)) ?? ""

		expect(notice?.license).toBe("LGPL-2.1-or-later")
		expect(build).toContain(ffmpegManifest.ffmpeg.tag)
		expect(build).toContain(`Configured with: ${ffmpegManifest.ffmpeg.configure.join(" ")}.`)
		expect(build).toContain(`Emscripten ${ffmpegManifest.emcc}`)
		expect(build).not.toMatch(/--enable-(gpl|nonfree)/)
		expect(terms.some(text => text.includes("GNU LESSER GENERAL PUBLIC LICENSE") && text.includes("Version 2.1, February 1999"))).toBe(
			true
		)

		// The corresponding source is pinned by content, never by a branch that moves on.
		for (const [name, hash] of Object.entries(ffmpegManifest.sources)) {
			expect(build).toContain(`packages/filen-web/scripts/codecs/${name} (SHA-256 ${hash})`)
		}

		expect(build).not.toContain("/tree/")
		// Where the library's own source is obtained, and how the module is rebuilt from it.
		expect(build).toContain(
			`Corresponding source of the library: the FFmpeg release tarball ${ffmpegManifest.ffmpeg.tarball} (SHA-256 ${ffmpegManifest.ffmpeg.sha256}), unmodified`
		)
		expect(build).toContain("packages/filen-web/src/vendor/ffmpeg-decoders/decoders.worker.js")
	})

	it("names the patch pnpm applies to every patched package that ships", () => {
		// What ships is the patched source; MPL-2.0 and the LGPL ask that recipients learn where it is.
		const workspace = readFileSync(new URL("../../../../pnpm-workspace.yaml", import.meta.url), "utf8")
		const section = /^patchedDependencies:\n((?:[ \t]+.*\n)+)/m.exec(workspace)?.[1] ?? ""
		const patches = [...section.matchAll(/^\s+'?(.+?)'?:\s+(\S+)\s*$/gm)].map(([, key, patch]) => ({ key, patch }))
		const shipped = patches.flatMap(({ key, patch }) =>
			THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "npm" && `${notice.name}@${notice.version}` === key).map(notice => ({
				notice,
				patch
			}))
		)

		expect(patches.length).toBeGreaterThan(0)
		expect(shipped.map(({ notice }) => notice.name)).toContain("mediabunny")

		for (const { notice, patch } of shipped) {
			expect(
				thirdPartyLicenseTexts(notice).some(text => text.includes(`the patch ${patch ?? ""} from the filen-ts repository`)),
				`${notice.name}@${notice.version} does not name ${patch ?? ""}`
			).toBe(true)
		}
	})

	it("describes what Emscripten links into the decoders module, with the license files the build copied", () => {
		// The assistant's engine is built with another Emscripten release, listed beside this one.
		const vendored = (name: string, version: string) =>
			THIRD_PARTY_NOTICES.find(notice => notice.ecosystem === "vendored" && notice.name === name && notice.version === version)
		const emscripten = vendored("Emscripten", ffmpegManifest.emcc)
		const musl = vendored("musl", ffmpegManifest.emscripten.musl)

		expect(emscripten).toMatchObject({ version: ffmpegManifest.emcc, license: "MIT OR NCSA" })
		expect(musl).toMatchObject({ version: ffmpegManifest.emscripten.musl, license: "MIT" })
		expect(emscripten === undefined ? [] : thirdPartyLicenseTexts(emscripten)).toContain(
			readFileSync(new URL("../vendor/ffmpeg-decoders/licenses/emscripten-LICENSE", import.meta.url), "utf8")
		)
		expect(musl === undefined ? [] : thirdPartyLicenseTexts(musl)).toContain(
			readFileSync(new URL("../vendor/ffmpeg-decoders/licenses/musl-COPYRIGHT", import.meta.url), "utf8")
		)
	})

	it("describes what the assistant's engine compiles in, as its manifest records it, with the license files the build copied", () => {
		// The manifest is rewritten by every engine build; a rebuild that skips the generator fails here.
		const license = (file: string) => readFileSync(new URL(`../vendor/wllama/licenses/${file}`, import.meta.url), "utf8")
		const expected = [
			{ name: "llama.cpp", version: wllamaManifest["llama.cpp"].commit.slice(0, 7), license: "MIT", file: "llama.cpp-LICENSE" },
			{ name: "nlohmann/json", version: wllamaManifest["nlohmann/json"].version, license: "MIT", file: "nlohmann-json-LICENSE" },
			{ name: "Dawn", version: wllamaManifest.dawn.tag, license: "BSD-3-Clause", file: "dawn-LICENSE" },
			{ name: "Emscripten", version: wllamaManifest.emcc.split(" ")[0] ?? "", license: "MIT OR NCSA", file: "emscripten-LICENSE" },
			{ name: "musl", version: wllamaManifest.emscripten.musl, license: "MIT", file: "musl-COPYRIGHT" }
		]

		// Every license file the build copied is cited.
		expect(expected.map(entry => entry.file).sort()).toEqual(Object.keys(wllamaManifest.licenses).sort())

		for (const { name, version, license: spdx, file } of expected) {
			const notice = THIRD_PARTY_NOTICES.find(
				entry => entry.ecosystem === "vendored" && entry.name === name && entry.version === version
			)
			const terms = notice === undefined ? [] : thirdPartyLicenseTexts(notice)

			expect(notice?.license, `${name} ${version}`).toBe(spdx)
			expect(terms, `${name} ${version}`).toContain(license(file))
			expect(
				terms.some(text => text.includes("src/vendor/wllama/wllama.wasm")),
				`${name} ${version}`
			).toBe(true)
		}

		const llama = THIRD_PARTY_NOTICES.find(entry => entry.ecosystem === "vendored" && entry.name === "llama.cpp")
		const build =
			(llama === undefined ? [] : thirdPartyLicenseTexts(llama)).find(text => text.includes(wllamaManifest["llama.cpp"].commit)) ?? ""

		// Where the source is, pinned by commit and by content.
		expect(build).toContain(wllamaManifest.wllama.commit)

		for (const [name, hash] of Object.entries(wllamaManifest.sources)) {
			expect(build).toContain(`packages/filen-web/scripts/wllama/${name} (SHA-256 ${hash})`)
		}
	})

	it("describes every font @filen/office ships, as its manifest records it", () => {
		const flat = (text: string) => text.replace(/\s+/g, " ").trim()

		for (const family of officeFontsManifest.families) {
			const notice = THIRD_PARTY_NOTICES.find(entry => entry.ecosystem === "vendored" && entry.name === family.name)
			const terms = notice === undefined ? [] : thirdPartyLicenseTexts(notice)
			const licence = readFileSync(
				new URL(`../../node_modules/@filen/office/assets/fonts/${family.licenseFile}`, import.meta.url),
				"utf8"
			)

			expect(notice, family.name).toMatchObject({ version: family.version, license: family.license, repository: family.source })
			expect(
				terms.some(text => text.includes(family.commit) && family.faces.every(face => text.includes(face.file))),
				family.name
			).toBe(true)
			// Terms are pooled on whitespace-normalised text, so a family may point at another package's copy.
			expect(
				terms.some(text => text.includes("SIL Open Font License") && flat(licence).includes(flat(text))),
				family.name
			).toBe(true)
		}
	})

	it("describes the code @filen/office derives from other projects, as its notices file records it", () => {
		// Every source the file names reaches the payload verbatim, so an edit to that file that skips the generator fails here.
		const record = readFileSync(new URL("../../node_modules/@filen/office/THIRD_PARTY_NOTICES.md", import.meta.url), "utf8")
		const sources = [...record.matchAll(/^- Source: (.+)$/gm)].map(([, source]) => (source ?? "").replaceAll("`", ""))
		const vendoredTexts = THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "vendored").flatMap(thirdPartyLicenseTexts)

		expect(sources.length).toBeGreaterThan(0)

		for (const source of sources) {
			expect(
				vendoredTexts.some(text => text.includes(`- Source: ${source}\n`)),
				source
			).toBe(true)
		}
	})

	it("describes every dictionary @filen/spellcheck ships, as its manifest records it, with its notice files verbatim", () => {
		expect(spellcheckManifest.dictionaries.length).toBeGreaterThan(0)

		for (const dictionary of spellcheckManifest.dictionaries) {
			const notice = THIRD_PARTY_NOTICES.find(
				entry => entry.ecosystem === "vendored" && entry.name === `Hunspell dictionary ${dictionary.name}`
			)

			expect(notice?.license).toBe(dictionary.license)
			expect(notice?.copyright).toEqual(dictionary.copyright)

			const texts = notice === undefined ? [] : thirdPartyLicenseTexts(notice)

			for (const file of dictionary.notices) {
				// Shipped byte for byte; some upstream notices are Latin-1.
				const bytes = readFileSync(new URL(`../../node_modules/@filen/spellcheck/dictionaries/${file.file}`, import.meta.url))
				const text = isUtf8(bytes) ? bytes.toString("utf8") : bytes.toString("latin1")

				expect(
					texts.some(shipped => shipped === text),
					`${dictionary.id}: ${file.file}`
				).toBe(true)
			}
		}
	})

	it("describes every crate the spellchecker's wasm compiles in", () => {
		const lock = readFileSync(new URL("../../node_modules/@filen/spellcheck/crate/Cargo.lock", import.meta.url), "utf8")
		const crates = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"\nsource = /g)].map(
			match => `${match[1] ?? ""}@${match[2] ?? ""}`
		)

		expect(crates.length).toBeGreaterThan(0)

		for (const crate of crates) {
			expect(
				THIRD_PARTY_NOTICES.some(entry => entry.ecosystem === "rust" && `${entry.name}@${entry.version}` === crate),
				crate
			).toBe(true)
		}
	})

	it("records a release tag as the crate source", () => {
		// A --allow-untagged run stamps worktree@<sha> and fails here on purpose: the escape hatch exists
		// for a local experiment, never for a committed payload.
		expect(THIRD_PARTY_NOTICES_FILEN_RS_REF).toMatch(/^filen-js@\d+\.\d+\.\d+$/)
		expect(THIRD_PARTY_NOTICES_SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
	})
})

describe("third-party notices surface", () => {
	const sample = THIRD_PARTY_NOTICES.find(notice => notice.name === "react")

	it("finds a package by its exact name and version", () => {
		expect(sample).toBeDefined()
		expect(findThirdPartyNotice(sample?.name ?? "", sample?.version ?? "")).toBe(sample)
	})

	it("returns null for an unknown name and for a known name at a wrong version", () => {
		expect(findThirdPartyNotice("definitely-not-a-package", "1.0.0")).toBeNull()
		expect(findThirdPartyNotice(sample?.name ?? "", "0.0.0-nope")).toBeNull()
	})

	it("names one Emscripten for the decoders and libopenmpt modules, whose shared notice covers both", () => {
		expect(libopenmptManifest.emcc).toBe(ffmpegManifest.emcc)
		expect(libopenmptManifest.emscripten.musl).toBe(ffmpegManifest.emscripten.musl)

		for (const name of ["emscripten-LICENSE", "musl-COPYRIGHT"]) {
			expect(readFileSync(new URL(`../vendor/libopenmpt/licenses/${name}`, import.meta.url), "utf8"), name).toBe(
				readFileSync(new URL(`../vendor/ffmpeg-decoders/licenses/${name}`, import.meta.url), "utf8")
			)
		}
	})

	it("gives the stb_vorbis that stb-vorbis compiles in its own public-domain or MIT terms", () => {
		const stbVorbis = installed.find(entry => entry.name === "stb-vorbis")
		const notice = THIRD_PARTY_NOTICES.find(
			entry =>
				entry.ecosystem === "vendored" &&
				entry.name === "stb_vorbis" &&
				entry.version === `as compiled into stb-vorbis ${stbVorbis?.version ?? ""}`
		)

		expect(notice).toMatchObject({ license: "MIT OR Unlicense" })
		expect(notice === undefined ? [] : thirdPartyLicenseTexts(notice)).toContain(
			readFileSync(new URL("../vendor/libopenmpt/licenses/stb_vorbis-LICENSE", import.meta.url), "utf8")
		)
	})

	it("resolves every license text of an entry to a string", () => {
		const withText = THIRD_PARTY_NOTICES.find(notice => notice.texts.length > 0)

		if (!withText) {
			throw new Error("payload has no entry carrying a license text")
		}

		const texts = thirdPartyLicenseTexts(withText)

		expect(texts).toHaveLength(withText.texts.length)
		expect(texts.every(text => typeof text === "string" && text.length > 0)).toBe(true)
	})

	it("drops an out-of-range index rather than yielding undefined", () => {
		expect(
			thirdPartyLicenseTexts({
				name: "x",
				version: "1.0.0",
				license: "MIT",
				ecosystem: "npm",
				copyright: [],
				repository: null,
				texts: [0, LICENSE_TEXTS.length + 5]
			})
		).toEqual([LICENSE_TEXTS[0]])
	})

	it("returns no text for a text-less entry, never another package's", () => {
		expect(
			thirdPartyLicenseTexts({
				name: "x",
				version: "1.0.0",
				license: "MIT",
				ecosystem: "npm",
				copyright: [],
				repository: null,
				texts: []
			})
		).toEqual([])
	})

	it("returns the input identity for an empty or whitespace filter", () => {
		expect(filterThirdPartyNotices(THIRD_PARTY_NOTICES, "")).toBe(THIRD_PARTY_NOTICES)
		expect(filterThirdPartyNotices(THIRD_PARTY_NOTICES, "  ")).toBe(THIRD_PARTY_NOTICES)
	})

	it("matches on name case-insensitively and on SPDX id, and returns nothing for a no-match query", () => {
		expect(filterThirdPartyNotices(THIRD_PARTY_NOTICES, "ReAcT").some(notice => notice.name === "react")).toBe(true)
		expect(filterThirdPartyNotices(THIRD_PARTY_NOTICES, "mit").every(notice => /mit/i.test(`${notice.name}${notice.license}`))).toBe(
			true
		)
		expect(filterThirdPartyNotices(THIRD_PARTY_NOTICES, "zzzz-no-such-package-zzzz")).toEqual([])
	})
})

describe("noticeRepositoryHref", () => {
	it("links a plain http(s) repository URL", () => {
		expect(noticeRepositoryHref("https://github.com/facebook/react")).toBe("https://github.com/facebook/react")
		expect(noticeRepositoryHref("http://example.com/pkg")).toBe("http://example.com/pkg")
	})

	it("refuses a scheme no browser can navigate — the payload carries these verbatim from manifests", () => {
		expect(noticeRepositoryHref("git://github.com/cure53/DOMPurify")).toBeNull()
		expect(noticeRepositoryHref("git+https://github.com/dsherret/ts-morph.git")).toBeNull()
		expect(noticeRepositoryHref("ssh://git@github.com/owner/repo.git")).toBeNull()
		expect(noticeRepositoryHref("github:owner/repo")).toBeNull()
	})

	it("refuses npm's bare owner/repo shorthand, which would resolve as an in-app relative link", () => {
		expect(noticeRepositoryHref("sindresorhus/merge-streams")).toBeNull()
	})

	it("refuses a hostile scheme and a missing repository", () => {
		expect(noticeRepositoryHref("javascript:alert(1)")).toBeNull()
		expect(noticeRepositoryHref("  Java\tScript:alert(1)")).toBeNull()
		expect(noticeRepositoryHref("data:text/html,<script>alert(1)</script>")).toBeNull()
		expect(noticeRepositoryHref(null)).toBeNull()
	})

	it("never hands the shipped payload a value it would render as a live but unusable link", () => {
		const linked = THIRD_PARTY_NOTICES.map(notice => noticeRepositoryHref(notice.repository)).filter(href => href !== null)

		expect(linked.every(href => href.startsWith("https://") || href.startsWith("http://"))).toBe(true)
	})
})
