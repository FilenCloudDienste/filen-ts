import { describe, expect, it, vi, type MockInstance } from "vitest"
import type { SheetReadSource } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { BASIC, buildFixture, openFixture } from "./sheetSessionFixtures"

// A grid over a read-only source (a database's tables): it reads tiles, layouts and cells through the source alone,
// and every change is refused as read-only without reaching it.

async function readOnly(): Promise<{ model: SheetGridModel; source: SheetReadSource; command: MockInstance }> {
	const { session, info } = await openFixture(buildFixture(BASIC))
	const command = vi.spyOn(session, "command")
	const source: SheetReadSource = {
		tiles: (sheet, coordinates) => session.tiles(sheet, coordinates),
		release: keys => {
			session.release(keys)
		},
		layout: sheet => session.layout(sheet),
		query: (name, request, options) => session.query(name, request, options)
	}

	return { model: new SheetGridModel({ source, info }), source, command }
}

describe("sheet grid model without an edit API", () => {
	it("refuses commands, undo and redo as read-only and never sends them", async () => {
		const { model, command } = await readOnly()
		const sheet = model.getSnapshot().sheet

		await expect(model.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 })).resolves.toMatchObject({
			ok: false,
			refusal: { reason: "readOnly" }
		})
		await expect(model.undo()).resolves.toMatchObject({ ok: false, refusal: { reason: "readOnly" } })
		await expect(model.redo()).resolves.toMatchObject({ ok: false, refusal: { reason: "readOnly" } })
		expect(command).not.toHaveBeenCalled()
	})

	it("answers an edit intent with the writability it has", async () => {
		const { model } = await readOnly()

		expect(await model.intent()).toBe(model.getSnapshot().writability)
	})

	it("reads tiles through the source", async () => {
		const { model, source } = await readOnly()
		const tiles = vi.spyOn(source, "tiles")

		model.need(model.getSnapshot().sheet, [0, 0])
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(tiles).toHaveBeenCalled()
	})
})
