// @vitest-environment jsdom

// A note edited for years keeps hundreds of versions: the history list mounts a window of them, and the oldest one
// stays reachable and previewable.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement } from "react"
import type { Note, NoteHistory } from "@filen/sdk-rs"
import "@/lib/i18n"
import { stubElementSize } from "@/tests/stubElementSize"

const COUNT = 300

const { history } = vi.hoisted(() => ({
	history: Array.from({ length: 300 }, (_, index): NoteHistory => ({
		id: BigInt(index + 1),
		preview: `version ${String(index)}`,
		content: `content ${String(index)}`,
		editedTimestamp: 1_700_000_000_000n - BigInt(index) * 60_000n,
		editorId: 1n,
		noteType: "text"
	}))
}))

vi.mock("@/features/notes/queries/notes", () => ({ useLiveNote: (note: Note) => note }))
vi.mock("@/features/notes/queries/noteHistory", () => ({ useNoteHistoryQuery: () => ({ status: "success", data: history }) }))
vi.mock("@/features/notes/lib/history", () => ({ restoreNoteFromHistory: vi.fn() }))
vi.mock("@/features/notes/components/reader/noteReaderByType", () => ({
	NoteReaderByType: ({ content }: { content: string }) => createElement("p", null, content)
}))

import { HistoryDialog } from "@/features/notes/components/historyDialog"

const note = { uuid: "11111111-1111-1111-1111-111111111111", noteType: "text" } as unknown as Note

let restoreSize: () => void = () => undefined
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

beforeAll(() => {
	restoreSize = stubElementSize({ clientHeight: 400, clientWidth: 400 })
	// Rows are measured, and jsdom measures every box as empty: each one reports a real row's height.
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 52 })
})

afterAll(() => {
	restoreSize()

	if (offsetHeight !== undefined) {
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight)
	}
})

afterEach(cleanup)

describe("HistoryDialog with many versions", () => {
	it("mounts a window of the versions, each placed among all of them", () => {
		render(createElement(HistoryDialog, { note, onClose: vi.fn() }))

		const rows = screen.getAllByRole("listitem")

		expect(rows.length).toBeGreaterThan(0)
		expect(rows.length).toBeLessThan(40)
		expect(rows[0]?.getAttribute("aria-setsize")).toBe(String(COUNT))
	})

	it("reaches the oldest version by scrolling, and previews it", () => {
		render(createElement(HistoryDialog, { note, onClose: vi.fn() }))

		const scroller = screen.getAllByRole("listitem")[0]?.closest("ul")?.parentElement

		if (scroller === null || scroller === undefined) {
			throw new Error("no scroller")
		}

		act(() => {
			scroller.scrollTop = COUNT * 54
			scroller.dispatchEvent(new Event("scroll"))
		})

		const oldest = screen.getAllByRole("listitem").find(row => row.getAttribute("aria-posinset") === String(COUNT))

		if (oldest === undefined) {
			throw new Error("oldest version not mounted")
		}

		expect(oldest.textContent).toContain(`version ${String(COUNT - 1)}`)

		fireEvent.click(within(oldest).getByRole("button", { name: "View" }))

		expect(screen.getByText(`content ${String(COUNT - 1)}`)).toBeTruthy()
	})

	it("restores from the preview page after a confirmation", () => {
		render(createElement(HistoryDialog, { note, onClose: vi.fn() }))

		const first = screen.getAllByRole("listitem")[0]

		if (first === undefined) {
			throw new Error("no rows")
		}

		fireEvent.click(within(first).getByRole("button", { name: "View" }))
		fireEvent.click(screen.getByRole("button", { name: "Restore" }))

		expect(screen.getByText("Restore this version?")).toBeTruthy()
		expect(screen.getByText(/stays in the history/)).toBeTruthy()
	})
})
