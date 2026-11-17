// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { CellFlag } from "@filen/office/core/sheet"
import type { SheetGridHandle, SheetGridModel, SheetGridState, SheetShortcut } from "@filen/office/react/sheet"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { openGrid, workbook, sessionOf } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"

// The cards of notes, threads and links: an opened one is a dialog that takes focus, closes on Escape and once the
// selection leaves its cell, and gives focus back to the grid.

vi.mock("@/features/office/lib/officeSettings", () => ({
	useOfficeSettings: () => ({ authorName: "Ann", autosave: false, loaded: true }),
	ensureAuthorName: () => Promise.resolve("Ann")
}))
vi.mock("@/lib/trustedLinks/useTrustedLinkGate", () => ({
	useTrustedLinkGate: () => ({ intercept: () => true, onClick: () => undefined, onAuxClick: () => undefined, dialog: null })
}))

const { useSheetAnnotations } = await import("@/features/spreadsheet/comments/useSheetAnnotations")

interface Probe {
	shortcut: ((key: SheetShortcut) => boolean) | null
	pointer: ((event: unknown) => unknown) | null
}

function handle(focus: () => void): SheetGridHandle {
	return {
		cellRect: () => ({ x: 40, y: 20, width: 64, height: 20 }),
		onFrame: () => () => undefined,
		focus
	} as unknown as SheetGridHandle
}

function Annotations({
	grid,
	canEdit,
	gridHandle,
	onExtension
}: {
	grid: SheetGridState
	canEdit: boolean
	gridHandle: SheetGridHandle
	onExtension: (extension: SheetBodyExtension) => void
}) {
	const extension: SheetBodyExtension = useSheetAnnotations({
		grid,
		gridRef: { current: gridHandle },
		handle: { session: grid.model.session } as unknown as SheetHandle,
		canEdit,
		text: false
	})

	useEffect(() => {
		onExtension(extension)
	})

	return (
		<>
			<div style={{ position: "relative" }}>{extension.overlay}</div>
			{extension.dialogs}
		</>
	)
}

function select(model: SheetGridModel, row: number, col: number): void {
	act(() => {
		model.choose({
			active: { row, col },
			anchor: { row, col },
			focus: { row, col },
			ranges: [{ startRow: row, startCol: col, endRow: row, endCol: col }]
		})
	})
}

async function mount(canEdit: boolean): Promise<{ model: SheetGridModel; probe: Probe; focus: ReturnType<typeof vi.fn> }> {
	const model = await openGrid(
		await workbook([
			{
				name: "One",
				rows: [
					["a", "b"],
					["c", "d"]
				]
			}
		]),
		"xlsx"
	)

	sessionOf(model).configure({ author: "Ann" })
	expect((await sessionOf(model).command({ type: "note.set", sheet: 0, row: 1, col: 1, text: "Ann:\nfirst note" })).ok).toBe(true)

	const probe: Probe = { shortcut: null, pointer: null }
	const focus = vi.fn()
	const gridHandle = handle(focus)

	render(
		<GridHarness model={model}>
			{grid => (
				<Annotations
					grid={grid}
					canEdit={canEdit}
					gridHandle={gridHandle}
					onExtension={extension => {
						probe.shortcut = extension.shortcut ?? null
						probe.pointer = (extension.grid?.pointer as ((event: unknown) => unknown) | undefined) ?? null
					}}
				/>
			)}
		</GridHarness>
	)

	return { model, probe, focus }
}

async function openNote(model: SheetGridModel, probe: Probe): Promise<HTMLElement> {
	select(model, 1, 1)
	await waitFor(() => {
		expect(model.getSnapshot().active.flags).not.toBe(0)
	})
	act(() => {
		expect(probe.shortcut?.("note")).toBe(true)
	})

	const card = await screen.findByRole("dialog", {}, { timeout: 5000 })

	await waitFor(() => {
		expect(card.textContent).toContain("first note")
	})

	return card
}

describe("an opened annotation card", () => {
	it("takes focus, and closes once the selection leaves its cell", { timeout: 30_000 }, async () => {
		const { model, probe } = await mount(false)
		const card = await openNote(model, probe)

		expect(card.contains(document.activeElement)).toBe(true)
		select(model, 5, 5)
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
	})

	it("closes on Escape and gives the grid its focus back", { timeout: 30_000 }, async () => {
		const { model, probe, focus } = await mount(false)
		const card = await openNote(model, probe)

		fireEvent.keyDown(document.activeElement ?? card, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(focus).toHaveBeenCalled()
	})

	it("puts the caret in an editable note's field", { timeout: 30_000 }, async () => {
		const { model, probe } = await mount(true)
		const card = await openNote(model, probe)

		await waitFor(() => {
			expect(document.activeElement?.tagName).toBe("TEXTAREA")
		})
		expect(card.contains(document.activeElement)).toBe(true)
	})
})

describe("a link's card edited from another cell", () => {
	it("fills the dialog's text with the linked cell's text, not the active cell's", { timeout: 30_000 }, async () => {
		const { model, probe, focus } = await mount(true)

		select(model, 0, 0)
		act(() => {
			probe.shortcut?.("hyperlink")
		})
		fireEvent.change(await screen.findByRole("textbox", { name: /Address|previewSheetLinkAddress/ }), { target: { value: "filen.io" } })
		fireEvent.click(screen.getByRole("button", { name: /Apply|OK|previewSheetLinkApply/ }))
		await waitFor(() => {
			expect(model.getSnapshot().active.flags & CellFlag.HYPERLINK).not.toBe(0)
		})

		const linkedText = model.getSnapshot().active.text

		// B2 active; the pointer rests on A1.
		select(model, 1, 1)
		act(() => {
			probe.pointer?.({ kind: "hover", row: 0, col: 0, clientX: 0, clientY: 0 })
		})
		await screen.findByRole("tooltip", { hidden: true }, { timeout: 3000 })
		fireEvent.click(await screen.findByRole("button", { name: /^(Edit link…|previewSheetLinkEdit)$/, hidden: true }))

		const text = await screen.findByRole<HTMLInputElement>("textbox", { name: /Text to display|previewSheetLinkText/ })

		expect(linkedText).not.toBe(model.getSnapshot().active.text)
		expect(text.value).toBe(linkedText)

		// Closed, it gives the grid the keyboard back.
		focus.mockClear()
		fireEvent.keyDown(text, { key: "Escape" })
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull()
		})
		expect(focus).toHaveBeenCalled()
	})
})
