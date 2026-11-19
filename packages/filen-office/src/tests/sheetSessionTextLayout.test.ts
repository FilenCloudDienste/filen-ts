import { describe, expect, it } from "vitest"
import type { SheetChange, SheetCommandResult, SheetSessionApi } from "../core/sheet/protocol"
import { openTextSession } from "../core/sheet/text"
import { cells, changeOf } from "./sheetSessionFixtures"

// A text session's layout is its row and column counts: kept as edits go, sent only when they change.

async function open(text: string): Promise<SheetSessionApi> {
	const opened = await openTextSession(new TextEncoder().encode(text), { kind: "csv" }, () => undefined)

	if (opened.kind !== "opened") throw new Error(opened.kind)

	return opened.session
}

function counts(change: SheetChange): { rowCount?: number; colCount?: number } | null {
	const patch = change.layouts.find(layout => layout.sheet === 0)

	if (patch === undefined) return null

	return {
		...(patch.layout.rowCount !== undefined && { rowCount: patch.layout.rowCount }),
		...(patch.layout.colCount !== undefined && { colCount: patch.layout.colCount })
	}
}

const set = (session: SheetSessionApi, row: number, col: number, text: string): Promise<SheetCommandResult> =>
	session.command({ type: "cells.set", sheet: 0, cells: cells([[row, col, text]]) })

describe("text session layout", () => {
	it("sends no layout for an edit inside the text, and the new counts for one that grows it", async () => {
		const session = await open("a,b,c\nd,e\nf\n")

		expect(counts(changeOf(await set(session, 1, 0, "x")))).toBeNull()
		expect(counts(changeOf(await set(session, 2, 4, "y")))).toMatchObject({ colCount: 5 })
		expect(counts(changeOf(await set(session, 5, 0, "z")))).toMatchObject({ rowCount: 6 })
		session.close()
	})

	it("narrows back when the undo of the widest row's growth leaves no row as wide", async () => {
		const session = await open("a,b,c\nd,e\nf\n")

		changeOf(await set(session, 1, 6, "wide"))
		expect(counts(changeOf(await session.undo()))).toMatchObject({ colCount: 3 })
		expect(counts(changeOf(await session.redo()))).toMatchObject({ colCount: 7 })
		// Another row as wide: undoing the first growth keeps the width.
		changeOf(await set(session, 2, 6, "also"))
		expect(counts(changeOf(await session.undo()))).toBeNull()
		session.close()
	})

	it("counts the width again after columns and rows move", async () => {
		const session = await open("a,b,c,d\ne\nf,g\n")
		const deleteCols = { type: "axis.delete", sheet: 0, axis: "cols", at: 1, count: 2 } as const
		const deleteRow = { type: "axis.delete", sheet: 0, axis: "rows", at: 0, count: 1 } as const

		// a,d / e / f, then e / f.
		expect(counts(changeOf(await session.command(deleteCols)))).toMatchObject({ rowCount: 3, colCount: 2 })
		expect(counts(changeOf(await session.command(deleteRow)))).toMatchObject({ rowCount: 2, colCount: 1 })
		expect(counts(changeOf(await set(session, 1, 2, "h")))).toMatchObject({ colCount: 3 })
		expect(counts(changeOf(await session.undo()))).toMatchObject({ colCount: 1 })
		expect(counts(changeOf(await session.undo()))).toMatchObject({ rowCount: 3, colCount: 2 })
		expect(counts(changeOf(await session.undo()))).toMatchObject({ rowCount: 3, colCount: 4 })
		session.close()
	})
})
