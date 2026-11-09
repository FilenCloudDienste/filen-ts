import { describe, expect, it } from "vitest"
import { SheetGridModel } from "../react/sheet/model"
import { cellSelection } from "../react/sheet/selection"
import { BASIC, buildFixture, openFixture } from "./sheetSessionFixtures"

// A formula being typed points at another sheet's cells, as Excel's point mode does: showing another sheet keeps
// the entry open on its own, and ending it shows its own sheet again.

async function opened(): Promise<{ model: SheetGridModel; first: number; second: number }> {
	const { session, info } = await openFixture(buildFixture(BASIC))
	const model = new SheetGridModel({ session, info })

	return { model, first: info.activeSheet, second: model.getSnapshot().sheets[1]?.id as number }
}

describe("sheet grid model: pointing at another sheet", () => {
	it("keeps a formula open on its sheet while another is shown, and commits it there", async () => {
		const { model, first, second } = await opened()

		model.select(cellSelection({ row: 4, col: 0 }, []))
		model.startEditing("=1+", "enter")
		await model.showSheet(second)

		expect(model.getSnapshot().sheet).toBe(second)
		expect(model.getSnapshot().editing).toMatchObject({ sheet: first, row: 4, col: 0, text: "=1+" })

		model.setEditText("=1+Two!A1")

		expect(await model.commitEditing(cellSelection({ row: 5, col: 0 }, []))).toBe(true)
		expect(model.getSnapshot().sheet).toBe(first)
		expect(model.getSnapshot().selection.active).toEqual({ row: 5, col: 0 })
		expect((await model.session.query("cell", { sheet: first, row: 4, col: 0 })).input).toBe("=1+Two!A1")
	})

	it("shows the entry's sheet again when the entry is cancelled elsewhere", async () => {
		const { model, first, second } = await opened()

		model.startEditing("=", "enter")
		await model.showSheet(second)
		model.cancelEditing()

		expect(model.getSnapshot().sheet).toBe(first)
		expect(model.getSnapshot().editing).toBeNull()
	})

	it("reopens an incomplete formula committed from another sheet on its own sheet", async () => {
		const { model, first, second } = await opened()

		model.startEditing("=1+", "enter")
		await model.showSheet(second)

		expect(await model.commitEditing(null)).toBe(false)
		expect(model.getSnapshot().sheet).toBe(first)
		expect(model.getSnapshot().editing).toMatchObject({ sheet: first, text: "=1+", invalid: true })
	})

	it("commits any other entry before showing another sheet", async () => {
		const { model, first, second } = await opened()

		model.startEditing("typed", "enter")
		await model.showSheet(second)

		expect(model.getSnapshot().sheet).toBe(second)
		expect(model.getSnapshot().editing).toBeNull()
		expect((await model.session.query("cell", { sheet: first, row: 0, col: 0 })).input).toBe("typed")
	})
})
