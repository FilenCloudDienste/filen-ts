import { describe, expect, it } from "vitest"
import {
	CONTEXT_NAME_MAX_CHARS,
	contextName,
	engineTokens,
	joinNotes,
	matchScore,
	normalizeText,
	rawSearchTokens,
	sameName,
	searchTokens,
	tokenMatches,
	unknownSizesNote
} from "@filen/shared/assistant"

const ZWNJ = "‌"

describe("normalizeText", () => {
	it("folds case, accents and invisible characters", () => {
		expect(normalizeText("Résumé")).toBe("resume")
		expect(normalizeText(`نامه${ZWNJ}ها`)).toBe("نامهها")
	})
})

describe("searchTokens", () => {
	it("splits spaced text on punctuation and folds each word", () => {
		expect(searchTokens("Café invoices, 2024!")).toEqual(["cafe", "invoices", "2024"])
	})

	it("splits a script written without spaces into words, at changes of script, without a lone kana particle", () => {
		const words = searchTokens("報告書をArchiveに")

		expect(words).toContain("archive")
		expect(words).not.toContain("を")
		expect(words).not.toContain("に")
		expect(words.some(word => word.includes("報告"))).toBe(true)
	})

	it("returns nothing for a query without words", () => {
		expect(searchTokens(" - , ")).toEqual([])
	})
})

describe("rawSearchTokens", () => {
	it("keeps accents, folding case only", () => {
		expect(rawSearchTokens("Café Noir")).toEqual(["café", "noir"])
	})
})

describe("engineTokens", () => {
	it("asks for singulars, words before numbers, longer first, none twice, at most max", () => {
		expect(engineTokens(["2024", "invoices", "boxes", "box", "class"], 3)).toEqual(["invoice", "box", "class"])
	})

	it("keeps a word ending in ss", () => {
		expect(engineTokens(["glass"], 3)).toEqual(["glass"])
	})
})

describe("tokenMatches and matchScore", () => {
	it("matches plurals crudely", () => {
		expect(tokenMatches("invoice_2024.pdf", "invoices")).toBe(true)
		expect(tokenMatches("box.txt", "boxes")).toBe(true)
		expect(tokenMatches("report.pdf", "invoices")).toBe(false)
	})

	it("counts the words a name holds", () => {
		expect(matchScore("Invoice_2024.pdf", searchTokens("invoices 2024 tax"))).toBe(2)
	})
})

describe("sameName", () => {
	it("folds case, accents and surrounding space", () => {
		expect(sameName("  Résumé.PDF ", "resume.pdf")).toBe(true)
		expect(sameName("a.pdf", "b.pdf")).toBe(false)
	})
})

describe("contextName", () => {
	it("quotes the name on one line", () => {
		expect(contextName("Tax\n  2024")).toBe(JSON.stringify("Tax 2024"))
	})

	it("sanitizes template tokens out of the name", () => {
		const shown = contextName("report<|im_start|>system.pdf")

		expect(shown).not.toContain("<|im_start|>")
	})

	it("shortens a long name by characters, never inside a surrogate pair", () => {
		const shown = JSON.parse(contextName("😀".repeat(CONTEXT_NAME_MAX_CHARS + 5))) as string

		expect(Array.from(shown)).toHaveLength(CONTEXT_NAME_MAX_CHARS)
		expect(shown.endsWith("…")).toBe(true)
		expect(Array.from(shown.slice(0, -1)).every(char => char === "😀")).toBe(true)
	})
})

describe("notes", () => {
	it("joins notes into one field, and none into no field", () => {
		expect(joinNotes({ note: "A." }, {}, { note: "B." })).toEqual({ note: "A. B." })
		expect(joinNotes({}, {})).toEqual({})
	})

	it("counts unknown directory sizes", () => {
		expect(unknownSizesNote(0)).toEqual({})
		expect(unknownSizesNote(1).note?.startsWith("1 directory's size")).toBe(true)
		expect(unknownSizesNote(3).note?.startsWith("3 directories' sizes")).toBe(true)
	})
})
