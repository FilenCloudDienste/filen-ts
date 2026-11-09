import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult, SheetEvent } from "../core/sheet/protocol"
import { cells, firstTile, openFixture, tileTexts } from "./sheetSessionFixtures"

// A session reports circular references as Excel does: "circularReferences" events naming the first circular cell of
// each sheet, `introduced` once per circle an edit makes (Excel's warning), none under iterative calculation.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason}`)

	return result.change
}

function circular(events: readonly SheetEvent[]): Extract<SheetEvent, { type: "circularReferences" }>[] {
	return events.filter((event): event is Extract<SheetEvent, { type: "circularReferences" }> => event.type === "circularReferences")
}

const ROW =
	'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c><c r="C1"><f>B1+1</f><v>3</v></c></row></sheetData>'

describe("sheet session: circular references", () => {
	it("warns once of a circle an edit makes, shows 0 on it, names its cell while it lasts and none once it is gone", async () => {
		const { session, info, events } = await openFixture({ sheets: [{ name: "Data", body: ROW }] })
		const sheet = info.sheets[0]?.id ?? 0

		await firstTile(session, sheet)
		expect(await session.intent()).toEqual({ state: "writable" })

		const change = changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[0, 0, "=C1"]]) }))
		const tile = change.patches.find(patch => patch.sheet === sheet)

		expect(tile === undefined ? [] : ["0,0", "0,1", "0,2"].map(key => tileTexts(tile).get(key))).toEqual(["0", "0", "0"])
		expect(circular(events)).toEqual([{ type: "circularReferences", cells: [{ sheet, row: 0, col: 0 }], introduced: true }])

		// An edit that leaves the circle as it was says nothing.
		changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[1, 0, "4"]]) }))
		expect(circular(events)).toHaveLength(1)

		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(circular(events).at(-1)).toEqual({ type: "circularReferences", cells: [], introduced: false })
		session.close()
	})

	it("iterates under calcPr iterate, and reports no circle", async () => {
		const { session, info, events } = await openFixture({
			sheets: [{ name: "Data", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }],
			workbookTail: '<calcPr calcId="191029" iterate="1" iterateCount="10"/>'
		})
		const sheet = info.sheets[0]?.id ?? 0

		await firstTile(session, sheet)
		await session.intent()

		const change = changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[0, 1, "=B1+A1"]]) }))
		const tile = change.patches.find(patch => patch.sheet === sheet)

		expect(tile === undefined ? undefined : tileTexts(tile).get("0,1")).toBe("10")
		expect(circular(events)).toEqual([])
		session.close()
	})
})
