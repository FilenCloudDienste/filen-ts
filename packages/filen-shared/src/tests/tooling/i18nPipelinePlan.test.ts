import { describe, expect, it, vi } from "vitest"
import {
	applyRemovals,
	buildBatchRequest,
	catalogIssues,
	computeDelta,
	coveredKeyCount,
	coversEveryLanguage,
	englishSource,
	keysToTranslate,
	LANGUAGE_NAMES,
	markupSet,
	missingKeys,
	placeholderSet,
	translateBatch,
	translateDryRun,
	type BatchResponse
} from "@filen/shared/tooling/i18n"
import { SUPPORTED_LANGUAGES } from "@filen/shared/languages"

const EN = {
	cancel: "Cancel",
	files_one: "{{count}} file",
	files_other: "{{count}} files",
	link: "Open <link>{{name}}</link>"
}

describe("computeDelta", () => {
	it("is empty without a snapshot", () => {
		expect(computeDelta(null, EN)).toEqual({ upsert: {}, removed: [] })
	})

	it("lists changed and new keys as upserts and vanished ones as removals", () => {
		expect(computeDelta({ cancel: "Abort", gone: "x", files_one: "{{count}} file" }, EN)).toEqual({
			upsert: { cancel: "Cancel", files_other: "{{count}} files", link: "Open <link>{{name}}</link>" },
			removed: ["gone"]
		})
	})
})

describe("keysToTranslate", () => {
	const source = englishSource(EN)

	it("expands plural groups to the language's categories in full mode", () => {
		expect(Object.keys(keysToTranslate({ source, full: true, delta: { upsert: {}, removed: [] }, existing: {}, lang: "ru" })).sort()).toEqual(
			["cancel", "files_few", "files_many", "files_one", "files_other", "link"].sort()
		)
	})

	it("fills only what a target lacks, and a changed plural's whole group", () => {
		const existing = { cancel: "Abbrechen", files_one: "{{count}} Datei", files_other: "{{count}} Dateien" }

		expect(keysToTranslate({ source, full: false, delta: { upsert: {}, removed: [] }, existing, lang: "de" })).toEqual({ link: EN.link })
		expect(
			Object.keys(keysToTranslate({ source, full: false, delta: { upsert: { files_other: "x" }, removed: [] }, existing, lang: "de" })).sort()
		).toEqual(["files_one", "files_other", "link"])
	})

	it("adds the CLDR forms a reviewed group is missing without touching it", () => {
		const existing = { cancel: "a", link: "b", files_one: "c", files_other: "d" }

		expect(keysToTranslate({ source, full: false, delta: { upsert: {}, removed: [] }, existing, lang: "pl" })).toEqual({
			files_few: EN.files_other,
			files_many: EN.files_other
		})
	})
})

describe("applyRemovals", () => {
	it("drops a removed key and every plural sibling", () => {
		const target = { gone_one: "a", gone_few: "b", gone_other: "c", kept: "d" }

		applyRemovals(target, ["gone_one"])

		expect(target).toEqual({ kept: "d" })
	})
})

describe("coversEveryLanguage", () => {
	it("is true only for a run over every language", () => {
		expect(coversEveryLanguage(["de", "fr"], ["fr", "de"])).toBe(true)
		expect(coversEveryLanguage(["de"], ["fr", "de"])).toBe(false)
	})
})

describe("LANGUAGE_NAMES", () => {
	it("names every target language", () => {
		expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual(SUPPORTED_LANGUAGES.filter(lang => lang !== "en").sort())
	})
})

describe("translateBatch", () => {
	const ok: BatchResponse = { stop_reason: "end_turn", content: [{ type: "thinking" }, { type: "text", text: JSON.stringify({ cancel: "Abbrechen" }) }] }

	it("sends the cached system blocks and reads the reply", async () => {
		const createMessage = vi.fn(() => Promise.resolve(ok))

		await expect(
			translateBatch({ createMessage, model: "m", system: ["ctx"], lang: "de", languageName: "German", batch: { cancel: "Cancel" } })
		).resolves.toEqual({ cancel: "Abbrechen" })

		expect(createMessage).toHaveBeenCalledWith(buildBatchRequest({ model: "m", system: ["ctx"], languageName: "German", batch: { cancel: "Cancel" } }))
		expect(buildBatchRequest({ model: "m", system: ["a"], languageName: "German", batch: {} }).system).toEqual([
			{ type: "text", text: "a", cache_control: { type: "ephemeral" } }
		])
	})

	it("throws when the model stops early or returns no text", async () => {
		const args = { model: "m", system: [], lang: "de", languageName: "German", batch: {} }

		await expect(translateBatch({ ...args, createMessage: () => Promise.resolve({ stop_reason: "max_tokens", content: [] }) })).rejects.toThrow(
			"stopped early"
		)
		await expect(translateBatch({ ...args, createMessage: () => Promise.resolve({ stop_reason: "end_turn", content: [] }) })).rejects.toThrow(
			"No text content"
		)
	})

	it("has a free dry-run stub", () => {
		expect(translateDryRun("de", { a: "Cancel" })).toEqual({ a: "de:Cancel" })
	})
})

describe("catalog checks", () => {
	it("read placeholder and markup sets", () => {
		expect([...placeholderSet("{{a}} {{ b }} {{a}}")]).toEqual(["a", "b"])
		expect([...markupSet("<link>x</link><br/>")]).toEqual(["<link>", "</link>", "<br/>"])
	})

	it("pass a faithful translation", () => {
		const target = { cancel: "Отмена", files_one: "{{count}} файл", files_few: "{{count}} файла", files_many: "{{count}} файлов", files_other: "{{count}} файла", link: "<link>{{name}}</link>" }

		expect(catalogIssues(EN, target, "ru")).toEqual([])
		expect(missingKeys(EN, target)).toEqual([])
		expect(coveredKeyCount(EN, target)).toBe(4)
	})

	it("allow a _one form without {{count}}", () => {
		expect(catalogIssues(EN, { files_one: "Eine Datei", files_other: "{{count}} Dateien" }, "de")).toEqual([])
	})

	it("report placeholder, markup, plural and unknown-key problems", () => {
		const target = { cancel: "{{x}}", files_one: "{{count}} файл", files_other: "{{count}} файла", link: "{{name}}", extra: "?" }

		expect(catalogIssues(EN, target, "ru")).toEqual([
			"cancel: placeholders x differ from English ",
			"link: markup differs from English",
			"extra: not in English",
			"files: missing plural form _many",
			"files: missing plural form _few"
		])
		expect(catalogIssues(EN, { files_few: "{{count}}", files_one: "a", files_other: "b {{count}}" }, "de")).toContain(
			"files: plural form _few is never selected in de"
		)
		expect(missingKeys(EN, {})).toEqual(Object.keys(EN))
	})
})
