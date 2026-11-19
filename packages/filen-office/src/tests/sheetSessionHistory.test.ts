import { describe, expect, it } from "vitest"
import { parseCsvFile } from "../core/sheet/csv/csvView"
import type { SheetCommandResult, SheetDocState } from "../core/sheet/protocol"
import { sheetRegistry } from "../core/sheet/registry"
import { RenderStyleTable, SESSION_HISTORY_STEPS, SheetSession, sessionFeature } from "../core/sheet/session"
import { TEXT_SHEET, TextSheetDocument, textFeature } from "../core/sheet/text"
import { IMMEDIATE, cells, firstTile, tileTexts } from "./sheetSessionFixtures"

// The undo history's bounds: at most SESSION_HISTORY_STEPS steps and a byte budget, never evicting the newest step,
// and a save point whose step fell out stays unreachable.

// A text session built directly, so the byte budget can be set small.
async function open(historyBytes?: number): Promise<SheetSession<TextSheetDocument>> {
	const bytes = new TextEncoder().encode("a,b\r\n")
	const parsed = parseCsvFile(bytes, false)
	const styles = new RenderStyleTable()
	const document = new TextSheetDocument(bytes, parsed.rows, parsed.format, "csv", undefined, parsed.complete)
	const session = new SheetSession(
		document,
		styles,
		{
			features: own => sheetRegistry([textFeature, sessionFeature(own)]),
			...(historyBytes !== undefined && { historyBytes })
		},
		{ kind: "csv", slicing: IMMEDIATE },
		() => undefined
	)

	await session.start()

	return session
}

function stateOf(result: SheetCommandResult): SheetDocState {
	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)

	return result.change.state
}

function edit(session: SheetSession<TextSheetDocument>, text: string): Promise<SheetDocState> {
	return session.command({ type: "cells.set", sheet: TEXT_SHEET, cells: cells([[0, 0, text]]) }).then(stateOf)
}

// Undoes until nothing is left; how many steps were undone and the state after the last.
async function undoAll(session: SheetSession<TextSheetDocument>): Promise<{ steps: number; state: SheetDocState }> {
	let steps = 0
	let state = stateOf(await session.undo())

	steps++

	while (state.canUndo) {
		state = stateOf(await session.undo())
		steps++
	}

	return { steps, state }
}

// A one-cell step weighs 64 + (48 + 2 × before.length) + (48 + 2 × after.length) bytes (text.ts). `1${LARGE}` over
// "a" is 764 bytes and each LARGE-over-LARGE step 1364: one fits the 1500-byte budget alone, no two fit together.
const LARGE = "x".repeat(300)
const BUDGET = 1500

// Four-character values: 170 bytes over "a", then 176 each. Five 176-byte steps (880) fit SHORT_BUDGET, six do not.
const SHORT_BUDGET = 900
const SHORT_FIT = 5

function short(index: number): string {
	return index.toString().padStart(4, "0")
}

describe("the sheet undo history", () => {
	it("keeps the last SESSION_HISTORY_STEPS steps", async () => {
		const session = await open()

		for (let index = 0; index <= SESSION_HISTORY_STEPS; index++) await edit(session, `v${index}`)

		const { steps, state } = await undoAll(session)

		expect(steps).toBe(SESSION_HISTORY_STEPS)
		expect(state.canUndo).toBe(false)
		// The first edit fell out: undoing every kept step lands on it.
		expect(tileTexts(await firstTile(session, TEXT_SHEET)).get("0,0")).toBe("v0")
		session.close()
	})

	it("evicts older steps past the byte budget but never the newest", async () => {
		const session = await open(BUDGET)

		await edit(session, `1${LARGE}`)
		await edit(session, `2${LARGE}`)

		const state = await edit(session, `3${LARGE}`)

		expect(state.canUndo).toBe(true)

		const { steps } = await undoAll(session)

		expect(steps).toBe(1)
		expect(tileTexts(await firstTile(session, TEXT_SHEET)).get("0,0")).toBe(`2${LARGE}`)
		session.close()
	})

	it("keeps as many steps as fit the byte budget", async () => {
		const session = await open(SHORT_BUDGET)

		for (let index = 0; index < SHORT_FIT * 4; index++) await edit(session, short(index))

		expect((await undoAll(session)).steps).toBe(SHORT_FIT)
		session.close()
	})

	it("keeps the same steps across repeated undo and redo", async () => {
		const session = await open(SHORT_BUDGET)

		for (let index = 0; index < SHORT_FIT * 4; index++) await edit(session, short(index))

		for (let cycle = 0; cycle < 3; cycle++) {
			stateOf(await session.undo())
			stateOf(await session.redo())
		}

		expect((await undoAll(session)).steps).toBe(SHORT_FIT)
		expect(tileTexts(await firstTile(session, TEXT_SHEET)).get("0,0")).toBe(short(SHORT_FIT * 3 - 1))
		session.close()
	})

	it("keeps one step larger than the budget on its own", async () => {
		const session = await open(64)
		const state = await edit(session, LARGE)

		expect(state.canUndo).toBe(true)
		expect((await undoAll(session)).steps).toBe(1)
		expect(tileTexts(await firstTile(session, TEXT_SHEET)).get("0,0")).toBe("a")
		session.close()
	})

	it("counts a redone step against the budget again", async () => {
		const session = await open(BUDGET)

		await edit(session, `1${LARGE}`)
		stateOf(await session.undo())

		expect(stateOf(await session.redo()).canUndo).toBe(true)

		// The redone step and a new one pass the budget together: only the new one stays.
		await edit(session, `2${LARGE}`)

		expect((await undoAll(session)).steps).toBe(1)
		expect(tileTexts(await firstTile(session, TEXT_SHEET)).get("0,0")).toBe(`1${LARGE}`)
		session.close()
	})

	it("stays dirty when undoing back past a save point whose step fell out", async () => {
		const session = await open()

		await edit(session, "saved")

		const saved = await session.save()

		if (!saved.ok) throw new Error(saved.message)

		expect((await session.markSaved(saved.version)).dirty).toBe(false)

		for (let index = 0; index <= SESSION_HISTORY_STEPS; index++) await edit(session, `v${index}`)

		const { state } = await undoAll(session)

		expect(state.canUndo).toBe(false)
		expect(state.dirty).toBe(true)
		session.close()
	})
})
