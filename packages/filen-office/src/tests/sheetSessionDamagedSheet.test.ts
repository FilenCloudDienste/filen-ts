import { describe, expect, it } from "vitest"
import { XlsxParts } from "../core/xlsx/package/parts"
import type { SheetEvent } from "../core/sheet/protocol"
import { firstTile, openFixture, tileTexts, noise } from "./sheetSessionFixtures"

async function until(events: readonly SheetEvent[], type: SheetEvent["type"]): Promise<SheetEvent> {
	for (let i = 0; i < 400; i++) {
		const found = events.find(event => event.type === type)

		if (found !== undefined) return found

		await new Promise(resolve => setTimeout(resolve, 5))
	}

	throw new Error(`no ${type} event: ${events.map(event => event.type).join(",")}`)
}

describe("sheet session: a damaged sheet", () => {
	it("ends the session as failed when the active sheet is malformed past its preview, never as lossy", async () => {
		let rows = ""

		for (let row = 1; row <= 3000; row++)
			rows += `<row r="${row}"><c r="A${row}"><v>${row}</v></c><c r="B${row}" t="inlineStr"><is><t>${noise(200, row)}</t></is></c></row>`

		// Row 3001 is never closed: the part does not read.
		const { session, events } = await openFixture({
			sheets: [{ name: "One", body: `<sheetData>${rows}<row r="3001"><c r="A3001"><v>1</v></c></sheetData>` }]
		})

		expect(tileTexts(await firstTile(session, 0)).get("9,0")).toBe("10")

		const failed = await until(events, "failed")

		expect(failed).toMatchObject({ type: "failed" })
		await expect(session.intent()).rejects.toThrow()
		expect(
			events.some(event => event.type === "sheetReady" || (event.type === "writability" && event.writability.state === "viewOnly"))
		).toBe(false)
	})

	it("is read once: a request for it answers from the recorded failure", async () => {
		const reads: string[] = []
		const read = XlsxParts.prototype.read

		XlsxParts.prototype.read = function (this: XlsxParts, ...args: Parameters<XlsxParts["read"]>) {
			reads.push(args[0])

			return read.apply(this, args)
		}

		try {
			const { session } = await openFixture({
				sheets: [
					{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
					{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></sheetData>' }
				]
			})

			for (let i = 0; i < 5; i++) await expect(session.tiles(1, Uint32Array.of(0, 0))).rejects.toThrow()

			session.close()
		} finally {
			XlsxParts.prototype.read = read
		}

		expect(reads.filter(name => name.endsWith("sheet2.xml"))).toHaveLength(1)
	})

	it("is read once, the proof included", async () => {
		const reads: string[] = []
		const read = XlsxParts.prototype.read

		XlsxParts.prototype.read = function (this: XlsxParts, ...args: Parameters<XlsxParts["read"]>) {
			reads.push(args[0])

			return read.apply(this, args)
		}

		try {
			const { session } = await openFixture({
				sheets: [
					{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' },
					{ name: "Two", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></sheetData>' }
				]
			})

			await expect(session.tiles(1, Uint32Array.of(0, 0))).rejects.toThrow()
			await session.intent()
			await session.intent()
			session.close()
		} finally {
			XlsxParts.prototype.read = read
		}

		expect(reads.filter(name => name.endsWith("sheet2.xml"))).toHaveLength(1)
	})
})
