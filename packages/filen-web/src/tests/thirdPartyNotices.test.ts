import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { LICENSE_TEXTS } from "@/features/settings/thirdPartyNotices.gen"
import {
	filterThirdPartyNotices,
	findThirdPartyNotice,
	thirdPartyLicenseTexts,
	THIRD_PARTY_NOTICES,
	THIRD_PARTY_NOTICES_FILEN_RS_REF,
	THIRD_PARTY_NOTICES_SDK_VERSION
} from "@/features/settings/lib/thirdPartyNotices"

/**
 * The notices payload discharges a legal obligation, so the failure that matters is a SILENT one: a
 * dependency added or bumped without re-running scripts/generateThirdPartyNotices.ts leaves the shipped
 * attribution describing a tree the app no longer has, and nothing about the app misbehaves.
 *
 * The generator cannot run in CI (it needs a filen-rs checkout and the local cargo caches), so every
 * guard here reads only committed inputs: the payload itself and package-lock.json.
 */
interface LockEntry {
	version?: string
	dev?: boolean
	devOptional?: boolean
	optional?: boolean
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, LockEntry> }

/**
 * The packages the lockfile says ship, identified as `name@version` — the same identity the generator
 * dedupes on. A name-keyed set would silently excuse one of each multi-version package from the payload.
 *
 * `optional` is excluded alongside `dev` because npm decides per machine whether to install one, so
 * counting them would make the expectation depend on where the payload was generated.
 */
function lockfileShippingIds(): { ids: Set<string>; visited: number } {
	const ids = new Set<string>()
	let visited = 0

	for (const [key, meta] of Object.entries(lock.packages)) {
		if (!key.startsWith("node_modules/") || meta.dev === true || meta.devOptional === true || meta.optional === true) {
			continue
		}

		// This regex, not slice: a nested key is `a/node_modules/b` and the install path IS the key.
		const name = key.replace(/.*node_modules\//, "")

		if (typeof meta.version !== "string" || meta.version.length === 0) {
			throw new Error(`package-lock.json entry ${key} has no version`)
		}

		visited++
		ids.add(`${name}@${meta.version}`)
	}

	return { ids, visited }
}

const { ids: lockIds, visited: lockEntries } = lockfileShippingIds()
const payloadNpmIds = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "npm").map(n => `${n.name}@${n.version}`))
const BUILD_ONLY = ["vitest", "eslint", "prettier", "typescript"]

/** Names the lockfile itself ships at two or more distinct versions — computed, never hardcoded. */
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
		expect([...payloadNpmIds].filter(id => !lockIds.has(id)).sort(), "in the payload but not the lockfile — run npm ci").toEqual([])
	})

	it("was generated against the installed SDK", () => {
		// Turns three previously-silent failures red: generating from the wrong filen-rs checkout, merging a
		// payload built before an SDK bump, and any future bump that forgets to re-run the generator.
		expect(THIRD_PARTY_NOTICES_SDK_VERSION, `payload ref ${THIRD_PARTY_NOTICES_FILEN_RS_REF}`).toBe(
			lock.packages["node_modules/@filen/sdk-rs"]?.version
		)
	})

	it("reads a well-formed, non-empty id set from the lockfile", () => {
		expect(lockIds.size).toBeGreaterThan(0)
		expect([...lockIds].filter(id => !/^(@[^/]+\/)?[^/@]+@\S+$/.test(id)).sort()).toEqual([])
	})

	it("excludes build-only tooling from the id set", () => {
		// The cheap proof the dev filter actually ran on this side of the comparison.
		expect(BUILD_ONLY.filter(name => [...lockIds].some(id => id.startsWith(`${name}@`))).sort()).toEqual([])
	})

	it("includes a known shipping package at the version the lockfile states", () => {
		const react = lock.packages["node_modules/react"]?.version

		expect(typeof react).toBe("string")
		expect(lockIds.has(`react@${String(react)}`)).toBe(true)
	})

	it("collapses lockfile keys that share an id", () => {
		// Hoisting/nesting can reach one id at several keys; the payload holds one entry per id.
		expect(lockIds.size).toBeLessThanOrEqual(lockEntries)
	})

	it("keeps every version of a package the lockfile ships twice", () => {
		const names = multiVersionNames()

		// Skips rather than fails if a future dedupe removes every collision — the guard is the payload
		// matching the lockfile, not this tree happening to have multi-version packages.
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

	it("describes both ecosystems that ship", () => {
		expect([...new Set(THIRD_PARTY_NOTICES.map(notice => notice.ecosystem))].sort()).toEqual(["npm", "rust"])
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
