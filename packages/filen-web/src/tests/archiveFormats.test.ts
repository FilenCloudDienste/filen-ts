import { describe, expect, it } from "vitest"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"
import {
	ARCHIVE_NAME_EXTENSIONS,
	DEFAULTS,
	FORMAT_CHOICES,
	buildCompressFormat,
	choicesFor,
	effectiveLevel,
	formatChoice,
	hasLevels,
	isArchiveCandidateName,
	isFormatChoiceId,
	isFormatRunnable,
	probeFormat,
	withLevel,
	type FormatOptions
} from "@/features/drive/lib/archiveFormats"
import { archive } from "@/locales/en/archive"

const OPTIONS: FormatOptions = {
	level: 5,
	zipMethod: DEFAULTS.zipMethod,
	sevenZMethod: DEFAULTS.sevenZMethod,
	solid: DEFAULTS.solid,
	aes: DEFAULTS.aes,
	encryptNames: DEFAULTS.encryptNames
}

function info(overrides: Partial<ArchiveFormatInfo> = {}): ArchiveFormatInfo {
	return { extension: ".zip", levels: { min: 1, max: 9, defaultLevel: 6 }, maxLevel: 9, encoderMemory: 1024, ...overrides }
}

describe("FORMAT_CHOICES", () => {
	it("lists every format once, grouped, each with its own words", () => {
		const ids = FORMAT_CHOICES.map(choice => choice.id)

		expect(new Set(ids).size).toBe(19)
		expect(FORMAT_CHOICES.filter(choice => choice.group === "common").map(choice => choice.id)).toEqual([
			"zip",
			"7z",
			"tar.gz",
			"tar.xz",
			"tar.zst"
		])
		expect(FORMAT_CHOICES.filter(choice => choice.group === "single").map(choice => choice.id)).toEqual([
			"gz",
			"bz2",
			"xz",
			"lzma",
			"lz",
			"lz4",
			"br",
			"zst"
		])

		for (const choice of FORMAT_CHOICES) {
			expect(archive[choice.labelKey]).toBeTypeOf("string")
			expect(archive[choice.hintKey]).toBeTypeOf("string")
			expect(choice.displayExtension).toBe(`.${choice.id}`)
			expect(choice.encryptable).toBe(choice.family === "zip" || choice.family === "sevenZ")
		}
	})

	it("tells a format id from any other string", () => {
		expect(isFormatChoiceId("tar.zst")).toBe(true)
		expect(isFormatChoiceId("rar")).toBe(false)
		expect(formatChoice("tar.lz").codec).toBe("lzip")
		expect(formatChoice("lzma").codec).toBe("lzma")
	})

	it("offers the single-file group only for one file", () => {
		expect(choicesFor({ singleFile: true })).toHaveLength(19)
		expect(choicesFor({ singleFile: false }).some(choice => choice.group === "single")).toBe(false)
		expect(choicesFor({ singleFile: false })).toHaveLength(11)
	})
})

describe("hasLevels", () => {
	it("is false only for plain tar, stored ZIP and copy 7-Zip", () => {
		expect(hasLevels("tar", null)).toBe(false)
		expect(hasLevels("zip", "stored")).toBe(false)
		expect(hasLevels("7z", "copy")).toBe(false)
		expect(hasLevels("zip", "deflate")).toBe(true)
		expect(hasLevels("7z", "ppmd")).toBe(true)
		expect(hasLevels("tar.gz", null)).toBe(true)
		expect(hasLevels("zst", null)).toBe(true)
	})
})

describe("probeFormat", () => {
	it("asks level-agnostic and unencrypted, with no optional key set", () => {
		expect(probeFormat("zip")).toStrictEqual({ type: "zip", method: { type: "deflate", level: 1 } })
		expect(probeFormat("zip", "stored")).toStrictEqual({ type: "zip", method: { type: "stored" } })
		expect(probeFormat("zip", "lzma2")).toStrictEqual({ type: "zip", method: { type: "deflate", level: 1 } })
		expect(probeFormat("7z", "copy")).toStrictEqual({ type: "sevenZ", method: { type: "copy" }, solid: true })
		expect(probeFormat("7z", "bzip2")).toStrictEqual({ type: "sevenZ", method: { type: "bzip2", level: 1 }, solid: true })
		expect(probeFormat("tar")).toStrictEqual({ type: "tar" })
		expect(probeFormat("tar.br")).toStrictEqual({ type: "tar", compression: { codec: "brotli" } })
		expect(probeFormat("xz")).toStrictEqual({ type: "single", compression: { codec: "xz" } })
	})
})

describe("withLevel", () => {
	it("sets the level where the format takes one", () => {
		expect(withLevel(probeFormat("tar.gz"), 9)).toStrictEqual({ type: "tar", compression: { codec: "gzip", level: 9 } })
		expect(withLevel(probeFormat("zst"), 3)).toStrictEqual({ type: "single", compression: { codec: "zstd", level: 3 } })
		expect(withLevel(probeFormat("7z", "lzma"), 7)).toStrictEqual({ type: "sevenZ", method: { type: "lzma", level: 7 }, solid: true })
		expect(withLevel(probeFormat("tar"), 4)).toStrictEqual({ type: "tar" })
		expect(withLevel(probeFormat("zip", "stored"), 4)).toStrictEqual({ type: "zip", method: { type: "stored" } })
	})
})

describe("effectiveLevel", () => {
	it("is null for a format without levels", () => {
		expect(effectiveLevel(info({ levels: null, maxLevel: null }), 5)).toBeNull()
	})

	it("takes the SDK's default when nothing is wanted", () => {
		expect(effectiveLevel(info(), null)).toBe(6)
	})

	it("keeps a wanted level within the range and the memory's highest level", () => {
		expect(effectiveLevel(info({ maxLevel: 4 }), 8)).toBe(4)
		expect(effectiveLevel(info(), 0)).toBe(1)
		expect(effectiveLevel(info(), 12)).toBe(9)
		expect(effectiveLevel(info({ maxLevel: 7 }), 3)).toBe(3)
	})

	it("clamps the SDK's default too when the memory does not reach it", () => {
		expect(effectiveLevel(info({ maxLevel: 4 }), null)).toBe(4)
	})
})

describe("isFormatRunnable", () => {
	it("is false only when not even the lowest level fits", () => {
		expect(isFormatRunnable(info())).toBe(true)
		expect(isFormatRunnable(info({ levels: null, maxLevel: null }))).toBe(true)
		expect(isFormatRunnable(info({ maxLevel: null }))).toBe(false)
	})
})

describe("buildCompressFormat", () => {
	it("builds ZIP with its method and level, and AES only when encrypted", () => {
		expect(buildCompressFormat("zip", OPTIONS, false)).toStrictEqual({ type: "zip", method: { type: "deflate", level: 5 } })
		expect(buildCompressFormat("zip", { ...OPTIONS, aes: "aes128" }, true)).toStrictEqual({
			type: "zip",
			method: { type: "deflate", level: 5 },
			encryption: "aes128"
		})
		expect(buildCompressFormat("zip", { ...OPTIONS, zipMethod: "stored", level: null }, false)).toStrictEqual({
			type: "zip",
			method: { type: "stored" }
		})
	})

	it("builds 7-Zip with solid and the names encrypted as chosen", () => {
		expect(buildCompressFormat("7z", OPTIONS, false)).toStrictEqual({
			type: "sevenZ",
			method: { type: "lzma2", level: 5 },
			solid: true
		})
		expect(buildCompressFormat("7z", OPTIONS, true)).toStrictEqual({
			type: "sevenZ",
			method: { type: "lzma2", level: 5 },
			solid: true,
			encryption: "entriesAndHeaders"
		})
		expect(buildCompressFormat("7z", { ...OPTIONS, encryptNames: false, solid: false, sevenZMethod: "ppmd" }, true)).toStrictEqual({
			type: "sevenZ",
			method: { type: "ppmd", level: 5 },
			solid: false,
			encryption: "entries"
		})
		expect(buildCompressFormat("7z", { ...OPTIONS, sevenZMethod: "copy", level: null }, false)).toStrictEqual({
			type: "sevenZ",
			method: { type: "copy" },
			solid: true
		})
	})

	it("builds tarballs and single files with the codec's level, never encrypted", () => {
		expect(buildCompressFormat("tar.xz", OPTIONS, true)).toStrictEqual({ type: "tar", compression: { codec: "xz", level: 5 } })
		expect(buildCompressFormat("tar.lz4", { ...OPTIONS, level: null }, false)).toStrictEqual({
			type: "tar",
			compression: { codec: "lz4" }
		})
		expect(buildCompressFormat("tar", OPTIONS, true)).toStrictEqual({ type: "tar" })
		expect(buildCompressFormat("bz2", OPTIONS, false)).toStrictEqual({ type: "single", compression: { codec: "bzip2", level: 5 } })
	})

	it("refuses a leveled method without a level", () => {
		expect(() => buildCompressFormat("zip", { ...OPTIONS, level: null }, false)).toThrow("needs a level")
		expect(() => buildCompressFormat("7z", { ...OPTIONS, level: null }, false)).toThrow("needs a level")
	})
})

describe("isArchiveCandidateName", () => {
	it.each([
		"photos.zip",
		"photos.7z",
		"photos.tar",
		"photos.tar.gz",
		"photos.TGZ",
		"photos.tar.bz2",
		"photos.tbz",
		"photos.tbz2",
		"photos.tar.xz",
		"photos.txz",
		"photos.tar.zst",
		"photos.tzst",
		"photos.tar.lz",
		"photos.tlz",
		"photos.tar.lz4",
		"photos.tar.br",
		"photos.tar.lzma",
		"notes.txt.gz",
		"notes.txt.bz2",
		"notes.xz",
		"notes.lzma",
		"notes.lz",
		"notes.lz4",
		"notes.br",
		"notes.ZST",
		".tar.gz"
	])("offers %s", name => {
		expect(isArchiveCandidateName(name)).toBe(true)
	})

	it.each(["photos", "photos.rar", "photos.tb2", "photo.jpg", "zip", "photos.", "archive.zip.txt", "photos.gzip", ".zip", ".7Z"])(
		"does not offer %s",
		name => {
			expect(isArchiveCandidateName(name)).toBe(false)
		}
	)

	it("holds the last extension of each name the SDK reads as an archive", () => {
		expect([...ARCHIVE_NAME_EXTENSIONS].sort()).toEqual(
			["zip", "7z", "tar", "tgz", "tbz", "tbz2", "txz", "tlz", "tzst", "gz", "bz2", "xz", "lzma", "lz", "lz4", "br", "zst"].sort()
		)
	})
})
