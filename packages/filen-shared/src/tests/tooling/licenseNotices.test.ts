import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	describeCargoCrate,
	describedNotice,
	describeLicensing,
	finalizeNotices,
	poolLicenseTexts,
	repositoryOf,
	sortNoticeTexts,
	spdxOf,
	vendoredNotice,
	type PoolableNotice
} from "@filen/shared/tooling"

const APACHE =
	"Apache License\nVersion 2.0, January 2004\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\nAPPENDIX: How to apply the Apache License to your work."

const dirs: string[] = []

function packageDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "notices-"))

	dirs.push(dir)

	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(dir, name), text)
	}

	return dir
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

describe("describeLicensing", () => {
	it("elects the lightest alternative and lifts the holder out of the terms", () => {
		const dir = packageDir({
			"LICENSE-MIT": "MIT License\nCopyright (c) 2020 Someone\n\nPermission is hereby granted.",
			"LICENSE-APACHE": APACHE
		})

		expect(describeLicensing(dir, "(MIT OR Apache-2.0)")).toEqual({
			copyright: ["Copyright (c) 2020 Someone"],
			terms: ["MIT License\n\nPermission is hereby granted."]
		})
	})

	it("ships every license file for a conjunction", () => {
		const dir = packageDir({
			"LICENSE-MIT": "Permission is hereby granted.",
			"LICENSE-ZLIB": "This software is provided as-is."
		})

		expect(describeLicensing(dir, "MIT AND Zlib").terms.sort()).toEqual(["Permission is hereby granted.", "This software is provided as-is."])
	})

	it("describes nothing without a directory", () => {
		expect(describeLicensing(null, "MIT")).toEqual({ copyright: [], terms: [] })
	})
})

describe("describedNotice", () => {
	it("builds the entry in payload field order", () => {
		const dir = packageDir({ LICENSE: "Copyright (c) 2020 Someone\n\nPermission is hereby granted." })
		const entry = describedNotice({ name: "pkg", version: "1.0.0", license: "MIT", ecosystem: "npm", dir, repository: null })

		expect(Object.keys(entry)).toEqual(["name", "version", "license", "ecosystem", "copyright", "repository", "texts", "terms"])
		expect(entry).toEqual({
			name: "pkg",
			version: "1.0.0",
			license: "MIT",
			ecosystem: "npm",
			copyright: ["Copyright (c) 2020 Someone"],
			repository: null,
			texts: [],
			terms: ["Permission is hereby granted."]
		})
	})
})

describe("describeCargoCrate", () => {
	it("reads license and repository from Cargo.toml", () => {
		const dir = packageDir({
			"Cargo.toml": "[package]\nname = \"crate\"\nlicense = \"MIT OR Apache-2.0\"\nrepository = \"https://github.com/o/crate\"\n",
			"LICENSE-MIT": "Copyright (c) 2020 Someone\n\nPermission is hereby granted.",
			"LICENSE-APACHE": APACHE
		})

		expect(describeCargoCrate("crate", "1.0.0", dir)).toEqual({
			name: "crate",
			version: "1.0.0",
			license: "MIT OR Apache-2.0",
			ecosystem: "rust",
			copyright: ["Copyright (c) 2020 Someone"],
			repository: "https://github.com/o/crate",
			texts: [],
			terms: ["Permission is hereby granted."]
		})
	})

	it("is UNKNOWN without a directory or manifest", () => {
		const expected = { license: "UNKNOWN", repository: null, copyright: [], terms: [] }

		expect(describeCargoCrate("crate", "1.0.0", null)).toMatchObject(expected)
		expect(describeCargoCrate("crate", "1.0.0", packageDir({}))).toMatchObject(expected)
	})
})

describe("finalizeNotices", () => {
	it("pools terms, drops them and sorts by name then version", () => {
		const entry = (name: string, version: string, license: string, terms: string[]) => ({
			name,
			version,
			license,
			ecosystem: "npm" as const,
			copyright: [],
			repository: null,
			texts: [],
			terms
		})

		const { texts, notices } = finalizeNotices([
			entry("b", "1.0.0", "Apache-2.0", [APACHE]),
			entry("a", "2.0.0", "MIT", ["Permission is hereby granted."]),
			entry("a", "1.0.0", "MIT", [])
		])

		expect(texts).toEqual([APACHE, "Permission is hereby granted."])
		expect(notices.map(notice => [notice.name, notice.version, notice.texts])).toEqual([
			["a", "1.0.0", []],
			["a", "2.0.0", [1]],
			["b", "1.0.0", [0]]
		])
		expect(notices.every(notice => !("terms" in notice))).toBe(true)
	})
})

describe("sortNoticeTexts", () => {
	it("orders the texts and points every entry at the same texts as before", () => {
		const entry = (name: string, texts: number[]) => ({
			name,
			version: "1.0.0",
			license: "MIT",
			ecosystem: "npm" as const,
			copyright: [],
			repository: null,
			texts
		})
		const payload = { texts: ["MIT b", "Apache", "MIT a"], notices: [entry("x", [0, 2]), entry("y", [1]), entry("z", [])] }
		const sorted = sortNoticeTexts(payload)

		expect(sorted.texts).toEqual(["Apache", "MIT a", "MIT b"])
		expect(sorted.notices.map(notice => notice.texts.map(index => sorted.texts[index]))).toEqual([["MIT b", "MIT a"], ["Apache"], []])
	})
})

describe("poolLicenseTexts", () => {
	function notice(license: string, terms: string[]): PoolableNotice {
		return { license, terms, texts: [] }
	}

	it("pools whitespace variants and lends the Apache text only to Apache-elected packages", () => {
		const mit = notice("MIT", ["Permission is  hereby\ngranted."])
		const wrapped = notice("MIT", ["Permission is hereby granted."])
		const apache = notice("Apache-2.0", [APACHE])
		const bareApache = notice("Apache-2.0 OR GPL-3.0", [])
		const bareMit = notice("MIT OR Apache-2.0", [])

		const texts = poolLicenseTexts([mit, wrapped, apache, bareApache, bareMit])

		expect(texts).toEqual(["Permission is  hereby\ngranted.", APACHE])
		expect([mit.texts, wrapped.texts, apache.texts, bareApache.texts, bareMit.texts]).toEqual([[0], [0], [1], [1], []])
	})

	it("shares only identical texts with an entry that keeps its texts verbatim", () => {
		const mit = notice("MIT", ["Permission is  hereby\ngranted."])
		const kept = notice("MIT", ["Permission is hereby\fgranted."])
		const same = notice("MIT", ["Permission is hereby\fgranted."])
		const apache = notice("Apache-2.0", [APACHE])
		const texts = poolLicenseTexts([mit, kept, same, apache], entry => entry !== mit)

		expect(texts).toEqual(["Permission is  hereby\ngranted.", "Permission is hereby\fgranted.", APACHE])
		expect([mit.texts, kept.texts, same.texts]).toEqual([[0], [1], [1]])
	})

	it("throws when no canonical Apache text was pooled", () => {
		expect(() => poolLicenseTexts([notice("MIT", ["Permission is hereby granted."])])).toThrow(/canonical Apache-2.0/)
	})
})

describe("manifest fields", () => {
	it("reads SPDX ids and repository urls in their legacy shapes", () => {
		expect(spdxOf("MIT")).toBe("MIT")
		expect(spdxOf({ type: "ISC" })).toBe("ISC")
		expect(spdxOf([{ type: "BSD-3-Clause" }])).toBe("BSD-3-Clause")
		expect(spdxOf(undefined)).toBe("UNKNOWN")
		expect(repositoryOf({ url: "git+https://github.com/a/b.git" })).toBe("https://github.com/a/b")
		expect(repositoryOf(undefined)).toBeNull()
	})
})

describe("vendoredNotice", () => {
	const component = {
		name: "codec",
		version: "1.0.0",
		license: "LGPL-2.1-or-later",
		copyright: ["Copyright (c) the library developers", "Copyright (c) the library developers"],
		repository: "https://example.com/codec.git",
		terms: ["Built from codec 1.0.0 with --enable-decoder=x.", "LGPL terms"]
	}

	it("shapes the entry in the payload's field order, terms kept verbatim and holders deduplicated", () => {
		const entry = vendoredNotice(component, "vendored")

		expect(JSON.stringify(entry)).toBe(
			JSON.stringify({
				name: "codec",
				version: "1.0.0",
				license: "LGPL-2.1-or-later",
				ecosystem: "vendored",
				copyright: ["Copyright (c) the library developers"],
				repository: "https://example.com/codec.git",
				texts: [],
				terms: ["Built from codec 1.0.0 with --enable-decoder=x.", "LGPL terms"]
			})
		)
	})

	it("refuses a component that would ship without a license text or a holder", () => {
		expect(() => vendoredNotice({ ...component, terms: [] }, "vendored")).toThrow("codec@1.0.0")
		expect(() => vendoredNotice({ ...component, terms: [" "] }, "vendored")).toThrow("license text")
		expect(() => vendoredNotice({ ...component, copyright: [] }, "vendored")).toThrow("copyright")
		expect(() => vendoredNotice({ ...component, version: "" }, "vendored")).toThrow("version")
	})
})
