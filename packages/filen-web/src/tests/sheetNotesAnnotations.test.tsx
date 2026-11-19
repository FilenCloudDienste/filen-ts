// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import "@/lib/i18n"
import { CellFlag, type SheetSessionApi } from "@filen/office/core/sheet"
import type { SheetThread } from "@/features/spreadsheet/comments/annotations.logic"
import type { SheetCellPointer, SheetGridHandle, SheetGridModel, SheetGridState, SheetShortcut } from "@filen/office/react/sheet"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import { openGrid, workbook } from "@/tests/sheetMenusFixtures"
import { GridHarness } from "@/tests/sheetMenusHarness"
import { previewSheetNotes } from "@/locales/en/previewSheet/notes"
import { ShownNotes } from "@/features/spreadsheet/comments/shownNotes"

// Notes, comments and links in the sheet view, over a session on the in-thread host: Shift+F2 writes a note under
// the documents settings' author (its text starting with the author's line), a pointer resting on the cell shows it,
// Ctrl/Cmd+K links the cell, and Ctrl/Cmd+click on the link goes through the untrusted-domain confirmation.

const { intercept } = vi.hoisted(() => ({ intercept: vi.fn((_href: string) => true) }))

// The documents settings' author name (`stored`), and what the first-time author-name question answers (`answer`, null
// for declined) while none is stored; `pending`, when set, is the question still being resolved.
const author: { stored: string | null; answer: string | null; pending: Promise<string | null> | null } = vi.hoisted(() => ({
	stored: "Jan",
	answer: null,
	pending: null
}))

vi.mock("@/features/office/lib/officeSettings", () => ({
	useOfficeSettings: () => ({ authorName: author.stored, autosave: false, loaded: true }),
	ensureAuthorName: () => author.pending ?? Promise.resolve(author.stored ?? author.answer)
}))

vi.mock("@/lib/trustedLinks/useTrustedLinkGate", () => ({
	useTrustedLinkGate: () => ({ intercept, onClick: () => undefined, onAuxClick: () => undefined, dialog: null })
}))

const { useSheetAnnotations } = await import("@/features/spreadsheet/comments/useSheetAnnotations")

type NotesKey = keyof typeof previewSheetNotes

// A string as shown: its English text once the catalog holds it, else its key.
function label(key: NotesKey): RegExp {
	const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

	return new RegExp(`^(${escape(previewSheetNotes[key])}|${escape(key)})$`)
}

// The grid's handle as overlays use it: every cell on screen at a fixed box.
const HANDLE = {
	cellRect: () => ({ x: 40, y: 20, width: 64, height: 20 }),
	onFrame: () => () => undefined,
	focus: () => undefined
} as unknown as SheetGridHandle

interface Probe {
	pointer: ((event: SheetCellPointer) => unknown) | null
	shortcut: ((key: SheetShortcut) => boolean) | null
}

function Annotations({
	grid,
	handle = HANDLE,
	onExtension
}: {
	grid: SheetGridState
	handle?: SheetGridHandle | undefined
	onExtension: (extension: SheetBodyExtension) => void
}) {
	const extension = useSheetAnnotations({
		grid,
		gridRef: { current: handle },
		handle: { session: grid.model.session } as unknown as SheetHandle,
		canEdit: true,
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

// The session's author, as the sheet sets it from the documents settings.
function configureAuthor(model: SheetGridModel, name: string): void {
	// The grid model's read source is the whole session.
	;(model.session as unknown as SheetSessionApi).configure({ author: name })
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

describe("sheet notes and links in the view", () => {
	it(
		"writes a note from Shift+F2 under the author, shows it on hover, links a cell and asks before following it",
		{ timeout: 30_000 },
		async () => {
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
			const probe: Probe = { pointer: null, shortcut: null }

			render(
				<GridHarness model={model}>
					{grid => (
						<Annotations
							grid={grid}
							onExtension={extension => {
								probe.pointer = extension.grid?.pointer ?? null
								probe.shortcut = extension.shortcut ?? null
							}}
						/>
					)}
				</GridHarness>
			)

			select(model, 1, 1)
			act(() => {
				expect(probe.shortcut?.("note")).toBe(true)
			})

			const field = await screen.findByRole("textbox", { name: label("previewSheetNoteText") }, { timeout: 10_000 })

			expect((field as HTMLTextAreaElement).value).toBe("Jan:\n")
			fireEvent.change(field, { target: { value: "Jan:\nlooks right" } })
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetNoteSave") }))

			await waitFor(async () => {
				expect(await model.session.query("note.get", { sheet: model.getSnapshot().sheet, row: 1, col: 1 })).toMatchObject({
					text: "Jan:\nlooks right",
					author: "Jan"
				})
			})

			// A pointer resting on the cell shows the note, read-only.
			await waitFor(() => {
				expect(model.entry(model.getSnapshot().sheet, 1, 1)).not.toBeNull()
			})
			act(() => {
				probe.pointer?.({ kind: "hover", row: 1, col: 1, clientX: 0, clientY: 0 })
			})

			const card = await screen.findByRole("tooltip", {}, { timeout: 2000 })

			expect(card.textContent).toContain("looks right")
			act(() => {
				probe.pointer?.({ kind: "leave" })
			})
			await waitFor(() => {
				expect(screen.queryByRole("tooltip")).toBeNull()
			})

			// Ctrl/Cmd+K links the cell; Ctrl/Cmd+click on it asks before the domain opens.
			select(model, 0, 0)
			act(() => {
				expect(probe.shortcut?.("hyperlink")).toBe(true)
			})
			fireEvent.change(await screen.findByRole("textbox", { name: label("previewSheetLinkAddress") }), {
				target: { value: "filen.io/docs" }
			})
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetLinkApply") }))

			await waitFor(async () => {
				expect(await model.session.query("link.get", { sheet: model.getSnapshot().sheet, row: 0, col: 0 })).toMatchObject({
					url: "https://filen.io/docs"
				})
			})
			await waitFor(() => {
				expect(model.getSnapshot().active.flags & CellFlag.HYPERLINK).not.toBe(0)
			})
			act(() => {
				probe.pointer?.({ kind: "hover", row: 0, col: 0, clientX: 0, clientY: 0 })
			})
			await waitFor(() => {
				const taken = probe.pointer?.({
					kind: "down",
					row: 0,
					col: 0,
					clientX: 0,
					clientY: 0,
					pointerType: "mouse",
					ctrlKey: true,
					metaKey: true,
					shiftKey: false,
					altKey: false,
					editing: false
				})

				expect(taken).toBe(true)
				expect(intercept).toHaveBeenCalledWith("https://filen.io/docs")
			})
		}
	)
})

describe("sheet annotations around the author name and links to other sheets", () => {
	function mount(model: SheetGridModel, handle?: SheetGridHandle): Probe {
		const probe: Probe = { pointer: null, shortcut: null }

		render(
			<GridHarness model={model}>
				{grid => (
					<Annotations
						grid={grid}
						handle={handle}
						onExtension={extension => {
							probe.pointer = extension.grid?.pointer ?? null
							probe.shortcut = extension.shortcut ?? null
						}}
					/>
				)}
			</GridHarness>
		)

		return probe
	}

	async function ready(model: SheetGridModel, row: number, col: number, flag: number): Promise<void> {
		await waitFor(() => {
			expect(model.entry(model.getSnapshot().sheet, row, col)).not.toBeNull()
		})
		select(model, row, col)
		await waitFor(() => {
			expect(model.getSnapshot().active.flags & flag).not.toBe(0)
		})
	}

	it("keeps an edited note's card and text while the author name is declined", { timeout: 30_000 }, async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a", "b"]] }]), "xlsx")
		const sheet = model.getSnapshot().sheet

		configureAuthor(model, "Jan")
		expect((await model.command({ type: "note.set", sheet, row: 0, col: 1, text: "old" })).ok).toBe(true)

		const probe = mount(model)

		author.stored = null
		author.answer = null

		try {
			await ready(model, 0, 1, CellFlag.NOTE)
			act(() => {
				expect(probe.shortcut?.("note")).toBe(true)
			})

			const field = await screen.findByRole("textbox", { name: label("previewSheetNoteText") }, { timeout: 10_000 })

			fireEvent.change(field, { target: { value: "new words" } })
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: label("previewSheetNoteSave") }))
				await Promise.resolve()
			})

			// Declined: nothing written, the card and its text still there.
			expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: label("previewSheetNoteText") }).value).toBe("new words")
			expect(await model.session.query("note.get", { sheet, row: 0, col: 1 })).toMatchObject({ text: "old" })

			author.answer = "Ann"
			await waitFor(() => {
				expect(screen.getByRole<HTMLButtonElement>("button", { name: label("previewSheetNoteSave") }).disabled).toBe(false)
			})
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetNoteSave") }))

			await waitFor(async () => {
				expect(await model.session.query("note.get", { sheet, row: 0, col: 1 })).toMatchObject({ text: "new words" })
			})
			expect(screen.queryByRole("textbox", { name: label("previewSheetNoteText") })).toBeNull()
		} finally {
			author.stored = "Jan"
		}
	})

	it("keeps a reply's field and text while the author name is declined", { timeout: 30_000 }, async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a", "b"]] }]), "xlsx")
		const sheet = model.getSnapshot().sheet

		configureAuthor(model, "Jan")
		expect((await model.command({ type: "thread.add", sheet, row: 0, col: 0, text: "first" })).ok).toBe(true)

		const probe = mount(model)

		author.stored = null
		author.answer = null

		try {
			await ready(model, 0, 0, CellFlag.THREADED_COMMENT)
			act(() => {
				expect(probe.shortcut?.("note")).toBe(true)
			})
			fireEvent.click(await screen.findByRole("button", { name: label("previewSheetCommentReplyPlaceholder") }, { timeout: 10_000 }))

			const field = screen.getByRole("textbox", { name: label("previewSheetCommentReplyPlaceholder") })

			fireEvent.change(field, { target: { value: "my reply" } })
			await act(async () => {
				fireEvent.click(screen.getByRole("button", { name: label("previewSheetCommentReply") }))
				await Promise.resolve()
			})

			expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: label("previewSheetCommentReplyPlaceholder") }).value).toBe(
				"my reply"
			)

			author.answer = "Ann"
			await waitFor(() => {
				expect(screen.getByRole<HTMLButtonElement>("button", { name: label("previewSheetCommentReply") }).disabled).toBe(false)
			})
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetCommentReply") }))

			await waitFor(async () => {
				expect((await model.session.query("thread.get", { sheet, row: 0, col: 0 }))?.comments.map(comment => comment.text)).toEqual(
					["first", "my reply"]
				)
			})
			await waitFor(() => {
				expect(screen.queryByRole("textbox", { name: label("previewSheetCommentReplyPlaceholder") })).toBeNull()
			})
		} finally {
			author.stored = "Jan"
		}
	})

	it("names a comment thread without an author by the unknown author", { timeout: 30_000 }, async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a", "b"]] }]), "xlsx")
		const sheet = model.getSnapshot().sheet

		configureAuthor(model, "Jan")
		expect((await model.command({ type: "thread.add", sheet, row: 0, col: 0, text: "first" })).ok).toBe(true)

		// The session writes every comment under an author; a file can still hold a thread whose author is empty.
		const session = model.session as unknown as SheetSessionApi
		const query = session.query.bind(session)

		vi.spyOn(session, "query").mockImplementation((async (name: string, point: unknown) => {
			const value = await (query as (name: string, point: unknown) => Promise<unknown>)(name, point)

			return name === "thread.get" && value !== null
				? { ...(value as SheetThread), comments: (value as SheetThread).comments.map(comment => ({ ...comment, author: "" })) }
				: value
		}) as SheetSessionApi["query"])

		const probe = mount(model)

		await ready(model, 0, 0, CellFlag.THREADED_COMMENT)
		act(() => {
			expect(probe.shortcut?.("note")).toBe(true)
		})

		const card = await screen.findByRole("dialog", { name: /^Comment thread by / }, { timeout: 10_000 })

		expect(card.getAttribute("aria-label")).toBe("Comment thread by Unknown author")
	})

	it("posts a reply once when it is submitted again while the author name is still asked for", { timeout: 30_000 }, async () => {
		const model = await openGrid(await workbook([{ name: "One", rows: [["a", "b"]] }]), "xlsx")
		const sheet = model.getSnapshot().sheet

		configureAuthor(model, "Jan")
		expect((await model.command({ type: "thread.add", sheet, row: 0, col: 0, text: "first" })).ok).toBe(true)

		const probe = mount(model)
		const asked = Promise.withResolvers<string | null>()

		author.stored = null
		author.pending = asked.promise

		try {
			await ready(model, 0, 0, CellFlag.THREADED_COMMENT)
			act(() => {
				expect(probe.shortcut?.("note")).toBe(true)
			})
			fireEvent.click(await screen.findByRole("button", { name: label("previewSheetCommentReplyPlaceholder") }, { timeout: 10_000 }))

			const field = screen.getByRole("textbox", { name: label("previewSheetCommentReplyPlaceholder") })

			fireEvent.change(field, { target: { value: "my reply" } })
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetCommentReply") }))
			fireEvent.click(screen.getByRole("button", { name: label("previewSheetCommentReply") }))
			fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, metaKey: true })

			await act(async () => {
				asked.resolve("Ann")
				await asked.promise
			})

			await waitFor(() => {
				expect(screen.queryByRole("textbox", { name: label("previewSheetCommentReplyPlaceholder") })).toBeNull()
			})
			await waitFor(async () => {
				expect((await model.session.query("thread.get", { sheet, row: 0, col: 0 }))?.comments.length).toBeGreaterThan(1)
			})
			// Every submit was sent before the answer came, so a second one would be written by now.
			expect((await model.session.query("thread.get", { sheet, row: 0, col: 0 }))?.comments.map(comment => comment.text)).toEqual([
				"first",
				"my reply"
			])
		} finally {
			author.stored = "Jan"
			author.pending = null
		}
	})

	it("drops a link's follow to another sheet once the user went elsewhere", { timeout: 30_000 }, async () => {
		const model = await openGrid(
			await workbook([
				{ name: "One", rows: [["go", "b"]] },
				{ name: "Two", rows: [["x", "y"]] },
				{ name: "Three", rows: [["z"]] }
			]),
			"xlsx"
		)
		const [one, two, three] = model.getSnapshot().sheets.map(entry => entry.id)

		if (one === undefined || two === undefined || three === undefined) throw new Error("three sheets")

		expect(
			(
				await model.command({
					type: "link.set",
					sheet: one,
					ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
					target: { location: "Two!B2:C3" }
				})
			).ok
		).toBe(true)

		const listeners = new Set<() => void>()
		const goTo = vi.fn()
		const handle = {
			cellRect: () => ({ x: 40, y: 20, width: 64, height: 20 }),
			onFrame: (listener: () => void) => {
				listeners.add(listener)

				return () => {
					listeners.delete(listener)
				}
			},
			focus: () => undefined,
			goTo
		} as unknown as SheetGridHandle
		const paint = (): void => {
			act(() => {
				for (const listener of [...listeners]) listener()
			})
		}
		const probe = mount(model, handle)

		await ready(model, 0, 0, CellFlag.HYPERLINK)
		// The shown notes' own frame listener is not the follow's.
		const before = listeners.size

		act(() => {
			probe.pointer?.({
				kind: "down",
				row: 0,
				col: 0,
				clientX: 0,
				clientY: 0,
				pointerType: "mouse",
				ctrlKey: true,
				metaKey: true,
				shiftKey: false,
				altKey: false,
				editing: false
			})
		})
		await waitFor(() => {
			expect(model.getSnapshot().sheet).toBe(two)
		})
		expect(listeners.size).toBe(before + 1)

		// Elsewhere before the sheet was on show: the next frame drops the follow.
		act(() => {
			model.setSheet(three)
		})
		paint()
		expect(listeners.size).toBe(before)

		// Opened by hand later: no late jump to the link's place.
		act(() => {
			model.setSheet(two)
		})
		await waitFor(() => {
			expect(model.layout(two)).not.toBeNull()
		})
		paint()
		expect(goTo).not.toHaveBeenCalled()
		expect(model.getSnapshot().selection.active).not.toEqual({ row: 1, col: 1 })
	})
})

describe("notes shown all the time", () => {
	// A grid showing rows `top` to `top + 4`, and the frame listeners it would call after a paint.
	function fakeGrid() {
		const state = { top: 0, listeners: new Set<() => void>() }
		const handle = {
			cellRect: ({ row }: { row: number; col: number }) =>
				row >= state.top && row < state.top + 5 ? { x: 40, y: 20 * (row - state.top), width: 64, height: 20 } : null,
			onFrame: (listener: () => void) => {
				state.listeners.add(listener)

				return () => {
					state.listeners.delete(listener)
				}
			}
		} as unknown as SheetGridHandle

		const paint = (): void => {
			act(() => {
				for (const listener of [...state.listeners]) listener()
			})
		}

		return { state, handle, paint }
	}

	it("mounts and reads only the notes on screen, and reads them again after a change", async () => {
		const grid = fakeGrid()
		const texts = new Map<number, string>()
		const query = vi.fn((_name: string, point: { row: number }) =>
			Promise.resolve({ text: texts.get(point.row) ?? `note ${String(point.row)}`, author: "" })
		)
		const session = { query } as unknown as SheetSessionApi
		const cells = Uint32Array.from({ length: 1000 }, (_, index) => (index % 2 === 0 ? index / 2 : 0))
		const view = (version: number) => (
			<div style={{ position: "relative" }}>
				<ShownNotes
					gridRef={{ current: grid.handle }}
					session={session}
					sheet={1}
					cells={cells}
					version={version}
					rightToLeft={false}
				/>
			</div>
		)
		const { rerender } = render(view(1))

		await waitFor(() => {
			expect(screen.getAllByRole("note").map(note => note.textContent)).toEqual([0, 1, 2, 3, 4].map(row => `note ${String(row)}`))
		})
		expect(query).toHaveBeenCalledTimes(5)
		// A note without an author is still named.
		expect(screen.getAllByRole("note", { name: "Note by Unknown author" })).toHaveLength(5)

		// A change reads the mounted cards again, and only them.
		texts.set(2, "edited")
		rerender(view(2))
		await waitFor(() => {
			expect(screen.getByText("edited")).toBeTruthy()
		})
		expect(query).toHaveBeenCalledTimes(10)

		// Scrolling a row into view mounts its card and reads it; the others are not read again.
		grid.state.top = 1
		grid.paint()
		await waitFor(() => {
			expect(screen.getByText("note 5")).toBeTruthy()
		})
		expect(screen.queryByText("note 0")).toBeNull()
		expect(screen.getAllByRole("note")).toHaveLength(5)
		expect(query).toHaveBeenCalledTimes(11)
		expect(grid.state.listeners.size).toBe(1)
	})
})
