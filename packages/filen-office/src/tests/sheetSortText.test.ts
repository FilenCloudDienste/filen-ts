import { describe, expect, it } from "vitest"
import type { SheetCommand, SheetOpened } from "../core/sheet/protocol"
import { inThreadTextHost } from "../dom/sheet/text"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Sorting a text file: its fields read as Excel reads them (numbers, logical values, errors, text), the header row
// kept, whole rows moved as the file holds them, part of a row taking another's fields, columns left to right, and
// undo giving the file back byte for byte.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function open(text: string): Promise<SheetOpened> {
	const result = await inThreadTextHost().open(encoder.encode(text), { kind: "csv", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	return result
}

async function saved(opened: SheetOpened): Promise<string> {
	const result = await opened.session.save()

	if (!result.ok) throw new Error(result.reason)

	return decoder.decode(result.bytes)
}

function sort(
	range: { startRow: number; startCol: number; endRow: number; endCol: number },
	more: Partial<Extract<SheetCommand, { type: "sort.apply" }>> = {}
): SheetCommand {
	return {
		type: "sort.apply",
		sheet: 0,
		range,
		orientation: "rows",
		header: true,
		caseSensitive: false,
		keys: [{ index: 1, descending: false }],
		...more
	}
}

describe("sorting a text file", () => {
	it("orders numbers, text, logical values and errors, blanks last, the header kept", async () => {
		const source = "name,value,\r\na,TRUE,x\r\nb,10\r\nc,2\r\nd,#N/A\r\ne,banana\r\nf,\r\ng,-1\r\n"
		const opened = await open(source)

		expect((await opened.session.command(sort({ startRow: 0, startCol: 0, endRow: 7, endCol: 2 }))).ok).toBe(true)
		// Whole rows move with their own fields (row a keeps its trailing x, row f its empty field).
		expect(await saved(opened)).toBe("name,value,\r\ng,-1\r\nc,2\r\nb,10\r\ne,banana\r\na,TRUE,x\r\nd,#N/A\r\nf,\r\n")

		expect((await opened.session.undo()).ok).toBe(true)
		expect(await saved(opened)).toBe(source)
		opened.session.close()
	})

	it("orders percentages by the numbers Excel reads them as", async () => {
		const opened = await open("v\r\n50%\r\n7\r\nabc\r\n5%\r\n")

		expect(
			(
				await opened.session.command(
					sort({ startRow: 0, startCol: 0, endRow: 4, endCol: 0 }, { keys: [{ index: 0, descending: false }] })
				)
			).ok
		).toBe(true)
		expect(await saved(opened)).toBe("v\r\n5%\r\n50%\r\n7\r\nabc\r\n")
		opened.session.close()
	})

	it("sorts part of the rows, columns left to right, and descending", async () => {
		const opened = await open("k,3,x\nk,1,y\nk,2\n")

		expect((await opened.session.command(sort({ startRow: 0, startCol: 1, endRow: 2, endCol: 1 }, { header: false }))).ok).toBe(true)
		expect(await saved(opened)).toBe("k,1,x\nk,2,y\nk,3\n")

		expect(
			(
				await opened.session.command(
					sort(
						{ startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
						{ orientation: "cols", header: false, keys: [{ index: 0, descending: true }] }
					)
				)
			).ok
		).toBe(true)
		// Text sorts after numbers: descending, it comes first.
		expect((await saved(opened)).split("\n")[0]).toBe("x,k,1")
		opened.session.close()
	})
})

describe("sorting a text file in the session's locale", () => {
	const source = "Artikel;Preis\na;1,5\nb;1,25\nc;1,75\nd;1.234,56\ne;2\n"
	const range = { startRow: 0, startCol: 0, endRow: 5, endCol: 1 }

	it("reads decimal-comma numbers by their value where the locale writes them", async () => {
		const opened = await open(source)

		opened.session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })

		expect((await opened.session.command(sort(range))).ok).toBe(true)
		expect(await saved(opened)).toBe("Artikel;Preis\nb;1,25\na;1,5\nc;1,75\ne;2\nd;1.234,56\n")
		opened.session.close()
	})

	it("sorts what the locale reads as no number as text, after the numbers", async () => {
		const opened = await open(source)

		expect((await opened.session.command(sort(range))).ok).toBe(true)
		expect(await saved(opened)).toBe("Artikel;Preis\ne;2\nb;1,25\na;1,5\nc;1,75\nd;1.234,56\n")
		opened.session.close()
	})
})
