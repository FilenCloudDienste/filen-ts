import { describe, expect, it, vi } from "vitest"
import type { SheetCommandResult, SheetRange, SheetSessionApi } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { cellSelection } from "../react/sheet/selection"
import { entryText } from "../react/sheet/tiles"
import { BASIC, buildFixture, openFixture } from "./sheetSessionFixtures"

// A command's answer can carry a selection (a paste, a fill): it lands only when the user made no selection move
// after the command was sent; the answer's changes to the cells always land.

async function opened(): Promise<{ model: SheetGridModel; session: SheetSessionApi; sheet: number }> {
	const { session, info } = await openFixture(buildFixture(BASIC))

	return { model: new SheetGridModel({ session, info }), session, sheet: info.activeSheet }
}

function range(startRow: number, startCol: number, endRow: number, endCol: number): SheetRange {
	return { startRow, startCol, endRow, endCol }
}

function selected(model: SheetGridModel): { active: { row: number; col: number }; ranges: readonly SheetRange[] } {
	const { active, ranges } = model.getSnapshot().selection

	return { active: { row: active.row, col: active.col }, ranges }
}

async function cellText(model: SheetGridModel, sheet: number, row: number, col: number): Promise<string | null> {
	model.need(sheet, [row >>> 6, col >>> 5])

	for (let k = 0; k < 6; k++) await new Promise(resolve => setTimeout(resolve, 0))

	const found = model.entry(sheet, row, col)

	return found === null ? null : entryText(found.tile, found.entry)
}

// The session's undo and redo answers, with a selection the step restores.
function restoring(session: SheetSessionApi, sheet: number, at: SheetRange): void {
	const withSelection = (run: () => Promise<SheetCommandResult>) => async (): Promise<SheetCommandResult> => {
		const result = await run()

		if (!result.ok) return result

		return {
			...result,
			change: { ...result.change, selection: { sheet, activeRow: at.startRow, activeCol: at.startCol, ranges: [at] } }
		}
	}

	const undo = withSelection(session.undo.bind(session))
	const redo = withSelection(session.redo.bind(session))

	vi.spyOn(session, "undo").mockImplementation(undo)
	vi.spyOn(session, "redo").mockImplementation(redo)
}

describe("a command answer's selection", () => {
	it("lands when the user did not move", async () => {
		const { model, session, sheet } = await opened()
		const result = await model.command({ type: "clipboard.paste", sheet, at: { row: 4, col: 4 }, text: "x\ty" })

		expect(result.ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 4, col: 4 }, ranges: [range(4, 4, 4, 5)] })
		expect(await cellText(model, sheet, 4, 5)).toBe("y")
		session.close()
	})

	it("is dropped once the user moved before it landed, while the cells still change", async () => {
		const { model, session, sheet } = await opened()
		const pasted = model.command({ type: "clipboard.paste", sheet, at: { row: 4, col: 4 }, text: "x\ty" })

		model.select(cellSelection({ row: 1, col: 0 }, []))

		expect((await pasted).ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 1, col: 0 }, ranges: [range(1, 0, 1, 0)] })
		expect(await cellText(model, sheet, 4, 4)).toBe("x")
		expect(model.getSnapshot().state.canUndo).toBe(true)
		session.close()
	})

	it("is dropped for a fill too, and when the user switched sheets", async () => {
		const { model, session, sheet } = await opened()
		const filled = model.command({ type: "fill.auto", sheet, source: range(0, 0, 0, 0), target: range(0, 0, 3, 0), mode: "auto" })

		model.select(cellSelection({ row: 2, col: 2 }, []))
		await filled
		expect(selected(model)).toEqual({ active: { row: 2, col: 2 }, ranges: [range(2, 2, 2, 2)] })

		const second = model.getSnapshot().sheets[1]?.id as number
		const pasted = model.command({ type: "clipboard.paste", sheet, at: { row: 6, col: 0 }, text: "z" })

		model.setSheet(second)
		await pasted
		expect(model.getSnapshot().sheet).toBe(second)
		expect(await cellText(model, sheet, 6, 0)).toBe("z")
		session.close()
	})

	it("of a fill lands when the user did not move", async () => {
		const { model, session, sheet } = await opened()

		await model.command({ type: "fill.auto", sheet, source: range(0, 0, 0, 0), target: range(0, 0, 3, 0), mode: "auto" })
		expect(selected(model)).toEqual({ active: { row: 0, col: 0 }, ranges: [range(0, 0, 3, 0)] })
		session.close()
	})

	it("follows the commands in flight: the last sent after the last move wins", async () => {
		const { model, session, sheet } = await opened()

		// Two in flight, no move: each lands in turn, the later one last.
		const first = model.command({ type: "clipboard.paste", sheet, at: { row: 4, col: 4 }, text: "a" })
		const second = model.command({ type: "clipboard.paste", sheet, at: { row: 8, col: 2 }, text: "b\tc" })

		await Promise.all([first, second])
		expect(selected(model)).toEqual({ active: { row: 8, col: 2 }, ranges: [range(8, 2, 8, 3)] })

		// A move between them: the earlier answer's selection is dropped, the later one's (sent after it) lands.
		const before = model.command({ type: "clipboard.paste", sheet, at: { row: 10, col: 0 }, text: "d" })

		model.select(cellSelection({ row: 0, col: 1 }, []))

		const after = model.command({ type: "clipboard.paste", sheet, at: { row: 12, col: 1 }, text: "e" })

		await before
		expect(selected(model)).toEqual({ active: { row: 0, col: 1 }, ranges: [range(0, 1, 0, 1)] })
		await after
		expect(selected(model)).toEqual({ active: { row: 12, col: 1 }, ranges: [range(12, 1, 12, 1)] })

		// A move after both were sent: neither lands.
		const third = model.command({ type: "clipboard.paste", sheet, at: { row: 14, col: 0 }, text: "f" })
		const fourth = model.command({ type: "clipboard.paste", sheet, at: { row: 16, col: 0 }, text: "g" })

		model.select(cellSelection({ row: 2, col: 1 }, []))
		await Promise.all([third, fourth])
		expect(selected(model)).toEqual({ active: { row: 2, col: 1 }, ranges: [range(2, 1, 2, 1)] })
		expect(await cellText(model, sheet, 16, 0)).toBe("g")
		session.close()
	})

	it("of an undo or redo restores it when the user did not move, and leaves a later move alone", async () => {
		const { model, session, sheet } = await opened()
		const restored = range(4, 4, 4, 5)

		await model.command({ type: "clipboard.paste", sheet, at: { row: 4, col: 4 }, text: "x\ty" })
		model.select(cellSelection({ row: 0, col: 0 }, []))
		restoring(session, sheet, restored)

		expect((await model.undo()).ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 4, col: 4 }, ranges: [restored] })

		model.select(cellSelection({ row: 0, col: 0 }, []))
		expect((await model.redo()).ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 4, col: 4 }, ranges: [restored] })
		expect(await cellText(model, sheet, 4, 5)).toBe("y")

		const undone = model.undo()

		model.select(cellSelection({ row: 1, col: 1 }, []))
		expect((await undone).ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 1, col: 1 }, ranges: [range(1, 1, 1, 1)] })
		expect(await cellText(model, sheet, 4, 5)).toBeNull()

		const redone = model.redo()

		model.select(cellSelection({ row: 2, col: 0 }, []))
		expect((await redone).ok).toBe(true)
		expect(selected(model)).toEqual({ active: { row: 2, col: 0 }, ranges: [range(2, 0, 2, 0)] })
		expect(await cellText(model, sheet, 4, 5)).toBe("y")
		session.close()
	})
})
