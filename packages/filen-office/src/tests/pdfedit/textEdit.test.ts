import { describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import { layoutTextOverlay } from "../../core/pdfedit/textLayout"
import {
	applyAddText,
	applyTextEdit,
	hitTestText,
	narrowTarget,
	newTextFrame,
	prepareTextEdit,
	type TextEditTarget
} from "../../dom/pdfedit/textEdit"
import { matchPdfFont } from "../../core/pdfedit/fontMatch"
import { nodeFontAssets } from "../sheetPdfFixtures"
import { budget } from "../timing"
import {
	LATIN_CONTENT,
	LINE,
	SECOND,
	arimoCodes,
	fontsOf,
	makeDocument,
	pageChars,
	pageString,
	pdfjsRuns,
	reopen,
	save
} from "./textEditFixtures"

const TIMEOUT = budget(30_000)

// The baseline of LINE in display space (842 - 722) and of SECOND.
const LINE_Y = 120
const SECOND_Y = 150

function target(document: mupdf.PDFDocument, point: readonly [number, number], unit: "block" | "line" = "line"): TextEditTarget {
	const page = document.loadPage(0)
	const hit = hitTestText(page, point, { unit })

	page.destroy()

	if (hit.kind !== "target") throw new Error(`No target: ${hit.kind}`)

	return hit.target
}

function word(base: TextEditTarget, text: string): TextEditTarget {
	const start = base.text.indexOf(text)
	const narrowed = narrowTarget(base, start, start + text.length)

	if (narrowed === null) throw new Error(`No ${text} in ${base.text}`)

	return narrowed
}

async function overlayFor(edit: TextEditTarget, text: string, language?: string): Promise<Uint8Array> {
	const overlay = await layoutTextOverlay({
		pageWidth: edit.pageWidth,
		pageHeight: edit.pageHeight,
		frame: edit.frame,
		style: { font: edit.font, size: edit.size, color: edit.color, ...(language === undefined ? {} : { language }) },
		text,
		assets: nodeFontAssets
	})

	expect(overlay.missing).toBe(0)

	return overlay.bytes
}

// One journal operation as the command layer runs it.
function inOperation<T extends { status: string }>(document: mupdf.PDFDocument, run: () => T): T {
	document.beginOperation("Edit text")

	const result = run()

	if (result.status === "applied") document.endOperation()
	else document.abandonOperation()

	return result
}

function near(chars: ReturnType<typeof pageChars>, c: string, x: number, y: number): boolean {
	return chars.some(char => char.c === c && Math.abs(char.x - x) < 0.05 && Math.abs(char.y - y) < 0.05)
}

describe("hit-testing text", () => {
	it("reads a line's text, size, colour and matched font", () => {
		const document = makeDocument({ pages: [{ content: `0.8 0 0 rg ${LATIN_CONTENT}` }] })
		const edit = target(document, [100, LINE_Y - 4])

		expect(edit.text).toBe(LINE)
		expect(edit.size).toBeCloseTo(12, 3)
		expect(edit.color).toBe(0xcc0000)
		expect(edit.font).toMatchObject({ family: "arimo", label: "Arimo", bold: false, italic: false, substitute: false })
		expect(edit.frame.origin[0]).toBeCloseTo(72, 1)
		expect(edit.frame.origin[1]).toBeCloseTo(LINE_Y, 1)
		expect(edit.frame.width).toBeNull()
		expect(edit.pageWidth).toBe(595)
		expect(edit.pageHeight).toBe(842)
		document.destroy()
	})

	it("takes a block's lines, joined by line feeds, with the block's width and line spacing", () => {
		const content = "BT /F1 12 Tf 14 TL 72 722 Td (First line of a block) Tj T* (and its second) Tj ET"
		const document = makeDocument({ pages: [{ content }] })
		const edit = target(document, [80, LINE_Y + 10], "block")

		expect(edit.text).toBe("First line of a block\nand its second")
		expect(edit.frame.lineHeight).toBeCloseTo(14, 1)
		expect(edit.frame.width).toBeGreaterThan(100)
		document.destroy()
	})

	it("flags a font that is shown in a substitute", () => {
		const document = makeDocument({ pages: [{ content: "BT /F2 14 Tf 72 722 Td (Garamond text) Tj ET" }] })
		const edit = target(document, [100, LINE_Y - 4])

		expect(edit.fontName).toContain("Garamond")
		expect(edit.font).toMatchObject({ family: "tinos", italic: true, substitute: true, label: "Tinos" })
		document.destroy()
	})

	it("refuses Type 3 glyphs and vertical writing, and glyphs drawn as outlines", () => {
		const content = [
			"BT /F3 20 Tf 72 600 Td (AAA) Tj ET",
			`BT /F4 20 Tf 300 700 Td ${arimoCodes("Vert")} Tj ET`,
			"0 g 72 400 m 80 430 l 88 400 l h f 90 400 m 98 430 l 106 400 l h f"
		].join(" ")
		const document = makeDocument({ pages: [{ content }] })
		const page = document.loadPage(0)

		expect(hitTestText(page, [80, 842 - 605])).toEqual({ kind: "refused", reason: "cantEdit" })
		const vertical = pageChars(document, 0).find(char => char.c === "V")

		expect(vertical).toBeDefined()
		expect(
			hitTestText(page, [
				((vertical?.quad[0] ?? 0) + (vertical?.quad[6] ?? 0)) / 2,
				((vertical?.quad[1] ?? 0) + (vertical?.quad[7] ?? 0)) / 2
			])
		).toEqual({
			kind: "refused",
			reason: "cantEdit"
		})
		expect(hitTestText(page, [80, 842 - 410])).toEqual({ kind: "refused", reason: "cantEdit" })
		expect(hitTestText(page, [400, 500])).toEqual({ kind: "none" })
		page.destroy()
		document.destroy()
	})

	it("refuses a baseline that bends", () => {
		const glyphs = [..."Curved"]
			.map((char, index) => `1 0 0 1 ${String(72 + index * 9)} ${String(722 + index * index * 1.5)} Tm (${char}) Tj`)
			.join(" ")
		const document = makeDocument({ pages: [{ content: `BT /F1 12 Tf ${glyphs} ET` }] })
		const page = document.loadPage(0)

		expect(hitTestText(page, [76, LINE_Y - 4], { unit: "block" })).toEqual({ kind: "refused", reason: "cantEdit" })
		page.destroy()
		document.destroy()
	})
})

describe("replacing text", () => {
	it(
		"replaces a word in the middle of a line and keeps its neighbours where they were",
		async () => {
			const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
			const before = pageChars(document, 0)
			const edit = word(target(document, [100, LINE_Y - 4]), "brave")
			const overlay = await overlayFor(edit, "BOLD")

			document.enableJournal()

			const result = inOperation(document, () => applyTextEdit(mupdf, document, 0, edit, overlay))

			expect(result).toEqual({ status: "applied", pages: [0], tagged: false })

			const after = pageChars(document, 0)
			const kept = before.filter(char => !edit.chars.some(gone => gone.c === char.c && gone.x === char.x && gone.y === char.y))

			for (const char of kept) expect(near(after, char.c, char.x, char.y)).toBe(true)
			for (const gone of edit.chars) expect(near(after, gone.c, gone.x, gone.y)).toBe(false)

			const saved = reopen(save(document))
			const text = pageString(saved, 0)

			expect(text).toContain("Hello ")
			expect(text).toContain(" new world")
			expect(text).toContain("BOLD")
			expect(text).toContain(SECOND)

			// The new word starts where the old one did, on its baseline.
			const bold = pageChars(saved, 0).find(char => char.c === "B" && Math.abs(char.y - LINE_Y) < 1)

			expect(bold?.x).toBeCloseTo(edit.frame.origin[0], 0)

			const runs = await pdfjsRuns(save(document), 1)
			const joined = runs.map(run => run.text).join("|")

			expect(joined).toContain("BOLD")
			expect(joined).toContain(SECOND)
			expect(joined).not.toContain("brave")
			saved.destroy()
			document.destroy()
		},
		TIMEOUT
	)

	it("undoes as one step", async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const edit = target(document, [100, LINE_Y - 4])
		const overlay = await prepareTextEdit(edit, "Replaced line", nodeFontAssets, { bold: true, size: 14 })
		const original = pageString(document, 0)

		document.enableJournal()
		inOperation(document, () => applyTextEdit(mupdf, document, 0, edit, overlay))
		expect(pageString(document, 0)).toContain("Replaced line")
		expect([...fontsOf(document, 0, "R")]).toEqual([expect.stringContaining("Arimo-Bold")])
		expect(pageChars(document, 0).find(char => char.c === "R")?.size).toBeCloseTo(14, 1)
		document.undo()
		expect(pageString(document, 0)).toBe(original)
		document.destroy()
	})

	it("edits text it set before", { timeout: TIMEOUT }, async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const first = target(document, [100, LINE_Y - 4])

		expect(applyTextEdit(mupdf, document, 0, first, await overlayFor(first, "First edit")).status).toBe("applied")

		const second = target(document, [80, LINE_Y - 4])

		expect(second.text).toBe("First edit")
		expect(second.font).toMatchObject({ family: "arimo", substitute: false })
		expect(applyTextEdit(mupdf, document, 0, second, await overlayFor(second, "Second edit")).status).toBe("applied")

		const text = pageString(reopen(save(document)), 0)

		expect(text).toContain("Second edit")
		expect(text).not.toContain("First")
		expect(text).toContain(SECOND)
		document.destroy()
	})

	it("aborts when removing the text would take a neighbour with it", () => {
		// "B" drawn 7 pt back over "A": its glyph box overlaps A's, so no quad can hold A without catching B.
		const document = makeDocument({ pages: [{ content: "BT /F1 12 Tf 72 722 Td [(A) 580 (B) ( tail)] TJ ET" }] })
		const base = target(document, [80, LINE_Y - 4])
		const edit = narrowTarget(base, 0, 1)

		if (edit === null) throw new Error("No A")

		const original = pageString(document, 0)

		document.enableJournal()

		const result = inOperation(document, () => applyTextEdit(mupdf, document, 0, edit, null))

		expect(result).toEqual({ status: "unsafe" })
		expect(pageString(document, 0)).toBe(original)
		expect(document.canUndo()).toBe(false)
		document.destroy()
	})

	it("deletes text when the new text is empty", async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const edit = word(target(document, [100, LINE_Y - 4]), "brave ")

		expect(await prepareTextEdit(edit, " ", nodeFontAssets)).toBeNull()
		expect(applyTextEdit(mupdf, document, 0, edit, null).status).toBe("applied")
		expect(pageString(document, 0)).toContain("Hello new world")
		document.destroy()
	})

	it("refuses a target whose glyphs are no longer on the page", () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const edit = target(document, [100, LINE_Y - 4])
		const moved: TextEditTarget = { ...edit, chars: edit.chars.map(char => ({ ...char, x: char.x + 3 })) }

		expect(applyTextEdit(mupdf, document, 0, moved, null)).toEqual({ status: "unsafe" })
		expect(pageString(document, 0)).toContain(LINE)
		document.destroy()
	})

	it("leaves other pending redactions as they were, unapplied", async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const page = document.loadPage(0)
		const first = page.createAnnotation("Redact")

		first.setQuadPoints([[72, SECOND_Y - 10, 120, SECOND_Y - 10, 72, SECOND_Y + 2, 120, SECOND_Y + 2]])
		first.setContents("Pending one")
		first.setAuthor("Reviewer")
		first.setPopup([300, 300, 400, 400])
		first.update()

		const second = page.createAnnotation("Redact")

		second.setRect([400, 600, 500, 650])
		second.setColor([1, 0, 0])
		second.update()

		const snapshot = (annotation: mupdf.PDFAnnotation): Record<string, string> => {
			const out: Record<string, string> = {}

			annotation.getObject().forEach((value, key) => {
				// Indirect numbers change when the file is rewritten: the appearance is compared by its content.
				if (key === "AP") out["AP"] = value.get("N").readStream().asString()
				else if (key !== "P" && key !== "Popup") out[String(key)] = value.resolve().toString()
			})

			return out
		}
		const expected = page.getAnnotations().map(snapshot)

		page.destroy()

		const edit = word(target(document, [100, LINE_Y - 4]), "new")
		const overlay = await overlayFor(edit, "old")

		document.enableJournal()
		expect(inOperation(document, () => applyTextEdit(mupdf, document, 0, edit, overlay)).status).toBe("applied")

		const saved = reopen(save(document))
		const reloaded = saved.loadPage(0)
		const redactions = reloaded.getAnnotations().filter(annotation => annotation.getType() === "Redact")

		expect(redactions.map(snapshot)).toEqual(expected)
		expect(redactions[0]?.getObject().get("Popup").isNull()).toBe(false)
		// Not applied: the text under the first one is still there.
		expect(pageString(saved, 0)).toContain(SECOND)
		reloaded.destroy()
		saved.destroy()
		document.destroy()
	})

	it(
		"sets right-to-left and CJK text in the Noto fallbacks",
		async () => {
			const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
			const arabic = "مرحبا بالعالم"
			const chinese = "中文测试"
			const edit = target(document, [100, LINE_Y - 4])
			const overlay = await overlayFor(edit, arabic, "ar")

			expect(applyTextEdit(mupdf, document, 0, edit, overlay).status).toBe("applied")

			const second = target(document, [100, SECOND_Y - 4])
			const cjkOverlay = await overlayFor(second, chinese, "zh-Hans")

			expect(applyTextEdit(mupdf, document, 0, second, cjkOverlay).status).toBe("applied")

			const bytes = save(document)
			const saved = reopen(bytes)
			const text = pageString(saved, 0)

			for (const char of arabic.replace(" ", "")) expect(text).toContain(char)
			for (const char of chinese) expect(text).toContain(char)
			expect([...fontsOf(saved, 0, "مرحبا")]).toEqual([expect.stringContaining("NotoNaskhArabic")])
			expect([...fontsOf(saved, 0, chinese)]).toEqual([expect.stringMatching(/Noto.*(SC|CJK)/u)])

			const joined = (await pdfjsRuns(bytes, 1)).map(run => run.text).join("")

			expect(joined).toContain(chinese)
			expect(joined).toMatch(/\p{Script=Arabic}{3}/u)

			// Right to left in a frame without a width: the line starts at the old line's start edge.
			const arabicChars = pageChars(saved, 0).filter(char => /\p{Script=Arabic}/u.test(char.c))

			expect(Math.min(...arabicChars.map(char => char.quad[0]))).toBeCloseTo(edit.frame.origin[0], 0)
			saved.destroy()
			document.destroy()
		},
		TIMEOUT
	)

	it("reports a tagged document", async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }], tagged: true })
		const edit = word(target(document, [100, LINE_Y - 4]), "world")

		expect(applyTextEdit(mupdf, document, 0, edit, await overlayFor(edit, "page"))).toEqual({
			status: "applied",
			pages: [0],
			tagged: true
		})
		document.destroy()
	})
})

describe("adding text", () => {
	it("grafts new text where nothing was", async () => {
		const document = makeDocument({ pages: [{ content: LATIN_CONTENT }] })
		const frame = newTextFrame([72, 300], 18)
		const overlay = await layoutTextOverlay({
			pageWidth: 595,
			pageHeight: 842,
			frame,
			style: {
				font: matchPdfFont({ name: "Helvetica", bold: true, italic: false, serif: false, mono: false }),
				size: 18,
				color: 0x0000ff
			},
			text: "Added note",
			assets: nodeFontAssets
		})

		expect(applyAddText(mupdf, document, 0, overlay.bytes)).toEqual({ pages: [0], tagged: false })

		const saved = reopen(save(document))
		const added = pageChars(saved, 0).filter(char => Math.abs(char.y - frame.origin[1]) < 1)

		expect(added.map(char => char.c).join("")).toBe("Added note")
		expect(added[0]?.x).toBeCloseTo(72, 0)
		expect(added[0]?.color).toBe(0x0000ff)
		expect(added[0]?.size).toBeCloseTo(18, 1)
		expect(pageString(saved, 0)).toContain(LINE)
		saved.destroy()
		document.destroy()
	})
})
