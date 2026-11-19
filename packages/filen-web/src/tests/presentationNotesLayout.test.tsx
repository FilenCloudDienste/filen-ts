// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

// The notes pane's layout (collapsed, height): kept in this device's kv store and read during boot, so the pane's
// first render has it; a resize is stored once it settles, never per step; nothing stored gives the pane's defaults.

const { stored, writes } = vi.hoisted(() => ({
	stored: new Map<string, unknown>(),
	writes: [] as { key: string; value: unknown }[]
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		writes.push({ key, value })
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

const KEY = "presentation.notesLayout.v1"

// One module for the file (the office engines register their steps once per module graph): the first test runs
// before boot read anything, the second is that read, the others run on what it held.
const { loadPresentationNotesLayout, presentationNotesLayout } = await import("@/features/presentation/components/commentsPane.logic")
const { PresentationNotesPane } = await import("@/features/presentation/components/notesPane")

const localStorageGet = vi.fn()
const localStorageSet = vi.fn()

beforeEach(() => {
	stored.clear()
	writes.length = 0
	vi.stubGlobal("localStorage", { getItem: localStorageGet, setItem: localStorageSet, removeItem: vi.fn() })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

describe("presentation notes layout", () => {
	it("with nothing stored (or nothing preloaded, as on a public link) applies the defaults: collapsed at phone widths", () => {
		const phone = render(
			<PresentationNotesPane
				text="Hello"
				phone
			/>
		)

		expect(screen.getByRole("button", { name: "Show notes" })).toBeTruthy()
		phone.unmount()

		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
			/>
		)
		expect(screen.getByRole("separator", { name: "Resize notes" }).getAttribute("aria-valuenow")).toBe("120")
	})

	it("opens with the layout boot read, from its first render", async () => {
		stored.set(KEY, { collapsed: false, height: 300 })

		await loadPresentationNotesLayout()
		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
			/>
		)

		expect(screen.getByRole("separator", { name: "Resize notes" }).getAttribute("aria-valuenow")).toBe("300")
		expect(localStorageGet).not.toHaveBeenCalled()
	})

	it("stores a resize once it settles, not per step, and a collapse at once", async () => {
		await loadPresentationNotesLayout()
		vi.useFakeTimers()
		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
			/>
		)

		const separator = screen.getByRole("separator", { name: "Resize notes" })

		for (let step = 0; step < 12; step++) fireEvent.keyDown(separator, { key: "ArrowUp" })

		expect(writes).toEqual([])
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})
		expect(writes).toHaveLength(1)
		expect(writes[0]).toEqual({ key: KEY, value: { collapsed: false, height: Number(separator.getAttribute("aria-valuenow")) } })

		fireEvent.click(screen.getByRole("button", { name: "Hide notes" }))
		expect(writes).toHaveLength(2)
		expect(writes[1]?.value).toMatchObject({ collapsed: true })
		expect(localStorageSet).not.toHaveBeenCalled()
	})

	it("stores a height still waiting when the pane closes", async () => {
		await loadPresentationNotesLayout()
		vi.useFakeTimers()

		const view = render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
			/>
		)

		// The test before left them collapsed.
		fireEvent.click(screen.getByRole("button", { name: "Show notes" }))
		writes.length = 0
		fireEvent.keyDown(screen.getByRole("separator", { name: "Resize notes" }), { key: "ArrowDown" })
		expect(writes).toEqual([])
		view.unmount()

		expect(writes).toHaveLength(1)
		expect(presentationNotesLayout()).toEqual(writes[0]?.value)
	})
})
