import { describe, expect, it } from "vitest"
import { CellFlag, SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetLocale, type SheetRange, type SheetSessionApi } from "../core/sheet/protocol"
import { firstTile, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"

// A text file's copy as clipboard HTML, pasted into a workbook: what the view shows comes across, numbers as numbers.

const GERMAN: SheetLocale = { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" }

async function pasted(
	csv: string,
	locale?: SheetLocale
): Promise<{ text: (col: number) => string | undefined; number: (col: number) => boolean }> {
	const source = await openKeys(csv)

	if (locale !== undefined) source.session.configure({ locale })

	const range = { startRow: 0, startCol: 0, endRow: 0, endCol: 7 }
	const copy = await source.session.query("copy", { sheet: 0, range, cut: false })
	const { html } = await source.session.query("copyHtml", { sheet: 0, range })

	if ("refused" in copy || html === null) throw new Error("no copy")

	const book = await openKeys({ sheets: [{ name: "S", body: sheetBody([[]]) }] })

	if (locale !== undefined) book.session.configure({ locale })

	expect((await book.session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 0, col: 0 }, html, text: copy.text })).ok).toBe(
		true
	)

	const tile = await firstTile(book.session, 0)

	source.session.close()
	book.session.close()

	return {
		text: col => tileEntry(tile, 0, col)?.text,
		number: col => ((tileEntry(tile, 0, col)?.flags ?? 0) & CellFlag.NUMBER) !== 0
	}
}

describe("a text file's copy pasted into a workbook", () => {
	it("pastes the numbers it shows as numbers, and text it shows as text", async () => {
		const cells = await pasted("42,1.5,abc,=1+1,1e5,12%,'7,2024-01-15\n")

		expect([0, 1, 2, 3, 4, 5, 6, 7].map(cells.number)).toEqual([true, true, false, false, false, true, false, true])
		expect(cells.text(3)).toBe("=1+1")
		expect(cells.text(4)).toBe("1e5")
		expect(cells.text(5)).toBe("12%")
		expect(cells.text(6)).toBe("'7")
	})

	it("reads the numbers in the session's locale", async () => {
		const cells = await pasted('"1,5","1.234,5",x\n', GERMAN)

		expect([0, 1, 2].map(cells.number)).toEqual([true, true, false])
		expect(cells.text(0)).toBe("1,5")
		// As typed into a workbook: grouping implies "#,##0.00".
		expect(cells.text(1)).toBe("1.234,50")
	})
})

async function saved(session: SheetSessionApi): Promise<string> {
	return new TextDecoder().decode(await savedBytes(session))
}

// A copy or cut of `range` as the web client sends it: the text, the clipboard HTML, and the clip id.
async function copied(
	session: SheetSessionApi,
	range: SheetRange,
	cut = false
): Promise<{ readonly clip: number; readonly text: string; readonly html: string }> {
	const copy = await session.query("copy", { sheet: 0, range, cut })
	const { html } = await session.query("copyHtml", { sheet: 0, range, cut })

	if ("refused" in copy || html === null) throw new Error("no copy")

	return { clip: copy.clip, text: copy.text, html }
}

describe("a text file's copy pasted as HTML into a text file", () => {
	it("pastes the session's own copy back byte for byte", async () => {
		const { session } = await openKeys("007,1.50,+5,12345678901234567890\n")
		const copy = await copied(session, { startRow: 0, startCol: 0, endRow: 0, endCol: 3 })

		expect(
			(
				await session.command({
					type: "clipboard.pasteHtml",
					sheet: 0,
					at: { row: 1, col: 0 },
					html: copy.html,
					text: copy.text,
					clip: copy.clip
				})
			).ok
		).toBe(true)
		expect(await saved(session)).toBe("007,1.50,+5,12345678901234567890\n007,1.50,+5,12345678901234567890\n")
		session.close()
	})

	it("moves the session's own cut, and undo puts it back", async () => {
		const { session } = await openKeys("a,b\nc,d\n")
		const cut = await copied(session, { startRow: 0, startCol: 0, endRow: 1, endCol: 1 }, true)

		expect(
			(
				await session.command({
					type: "clipboard.pasteHtml",
					sheet: 0,
					at: { row: 0, col: 3 },
					html: cut.html,
					text: cut.text,
					clip: cut.clip
				})
			).ok
		).toBe(true)
		expect(await saved(session)).toBe(",,,a,b\n,,,c,d\n")
		expect((await session.undo()).ok).toBe(true)
		expect(await saved(session)).toBe("a,b\nc,d\n")
		session.close()
	})

	it("keeps numeric-looking fields as their text in another text file", async () => {
		const source = await openKeys("007,1.50,12345678901234567890,+5\n")
		const copy = await copied(source.session, { startRow: 0, startCol: 0, endRow: 0, endCol: 3 })
		const target = await openKeys("x\n")

		expect(
			(
				await target.session.command({
					type: "clipboard.pasteHtml",
					sheet: 0,
					at: { row: 0, col: 0 },
					html: copy.html,
					text: copy.text
				})
			).ok
		).toBe(true)
		expect(await saved(target.session)).toBe("007,1.50,12345678901234567890,+5\n")
		source.session.close()
		target.session.close()
	})
})

describe("a text file's copy of whole columns and rows", () => {
	const copyText = async (session: SheetSessionApi, range: SheetRange): Promise<string> => {
		const copy = await session.query("copy", { sheet: 0, range, cut: false })

		if ("refused" in copy) throw new Error(copy.refused)

		return copy.text
	}

	it("copies the used cells of a whole column, a whole row and the whole sheet", async () => {
		const { session } = await openKeys("a,b\nc,d\ne\n")

		expect(await copyText(session, { startRow: 0, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 1 })).toBe("b\r\nd\r\n")
		expect(await copyText(session, { startRow: 1, startCol: 0, endRow: 1, endCol: SHEET_MAX_COLS - 1 })).toBe("c\td")
		expect(await copyText(session, { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: SHEET_MAX_COLS - 1 })).toBe(
			"a\tb\r\nc\td\r\ne\t"
		)
		session.close()
	})

	it("copies nothing from a range past the data", async () => {
		const { session } = await openKeys("a,b\n")

		expect(await copyText(session, { startRow: 5, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 1 })).toBe("")
		expect(await copyText(session, { startRow: 0, startCol: 4, endRow: 0, endCol: SHEET_MAX_COLS - 1 })).toBe("")
		session.close()
	})

	it("moves exactly the used cells of a whole column cut", async () => {
		const { session } = await openKeys("a,b\nc,d\n")
		const cut = await session.query("copy", {
			sheet: 0,
			range: { startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0 },
			cut: true
		})

		if ("refused" in cut) throw new Error(cut.refused)

		expect(
			(await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 0, col: 2 }, text: cut.text, clip: cut.clip })).ok
		).toBe(true)
		expect(await saved(session)).toBe(",b,a\n,d,c\n")
		session.close()
	})
})
