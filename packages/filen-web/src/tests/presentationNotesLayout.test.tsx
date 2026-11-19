// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import type { Type } from "arktype"

// The notes pane's layout (its height): kept in this device's kv store and read during boot, so the pane's first
// render has it; a resize is stored once it settles, never per step; nothing stored gives the pane's default. Whether
// the notes show is the view's one flag (the pane's chevron reports it), never stored with the layout.

const { stored, writes } = vi.hoisted(() => ({
	stored: new Map<string, unknown>(),
	writes: [] as { key: string; value: unknown }[]
}))

// Reads validate through the schema as the real adapter's do (decodeValue).
vi.mock("@/lib/storage/adapter", async () => {
	const { decodeValue } = await import("@/lib/storage/decode")

	return {
		kvGetJson: (key: string, schema: Type) => {
			const value = stored.get(key)

			return Promise.resolve(value === undefined ? null : decodeValue(value, schema, "kv", key))
		},
		kvSetJson: (key: string, value: unknown) => {
			writes.push({ key, value })
			stored.set(key, value)

			return Promise.resolve()
		},
		kvDelete: () => Promise.resolve()
	}
})

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
	it("with nothing stored (or nothing preloaded, as on a public link) applies the default height", () => {
		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed={false}
				onCollapsedChange={vi.fn()}
			/>
		)
		expect(screen.getByRole("separator", { name: "Resize notes" }).getAttribute("aria-valuenow")).toBe("120")
	})

	it("opens with the height boot read, from its first render, a value stored with the old collapsed flag too", async () => {
		stored.set(KEY, { collapsed: true, height: 300 })

		await loadPresentationNotesLayout()
		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed={false}
				onCollapsedChange={vi.fn()}
			/>
		)

		expect(screen.getByRole("button", { name: "Hide notes" })).toBeTruthy()
		expect(screen.getByRole("separator", { name: "Resize notes" }).getAttribute("aria-valuenow")).toBe("300")
		expect(presentationNotesLayout()).toEqual({ height: 300 })
		expect(localStorageGet).not.toHaveBeenCalled()
	})

	it("shows what the view says and reports the chevron to it, storing nothing for it", () => {
		const onCollapsedChange = vi.fn()
		const view = render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed
				onCollapsedChange={onCollapsedChange}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Show notes" }))
		expect(onCollapsedChange).toHaveBeenLastCalledWith(false)
		// The view has not answered yet: still collapsed.
		expect(screen.getByRole("button", { name: "Show notes" })).toBeTruthy()

		view.rerender(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed={false}
				onCollapsedChange={onCollapsedChange}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Hide notes" }))
		expect(onCollapsedChange).toHaveBeenLastCalledWith(true)
		expect(writes).toEqual([])
	})

	it("stores a resize once it settles, not per step, as the height alone", async () => {
		await loadPresentationNotesLayout()
		vi.useFakeTimers()
		render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed={false}
				onCollapsedChange={vi.fn()}
			/>
		)

		const separator = screen.getByRole("separator", { name: "Resize notes" })

		for (let step = 0; step < 12; step++) fireEvent.keyDown(separator, { key: "ArrowUp" })

		expect(writes).toEqual([])
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000)
		})
		expect(writes).toEqual([{ key: KEY, value: { height: Number(separator.getAttribute("aria-valuenow")) } }])
		expect(localStorageSet).not.toHaveBeenCalled()
	})

	it("stores a height still waiting when the pane closes", async () => {
		await loadPresentationNotesLayout()
		vi.useFakeTimers()

		const view = render(
			<PresentationNotesPane
				text="Hello"
				phone={false}
				collapsed={false}
				onCollapsedChange={vi.fn()}
			/>
		)

		fireEvent.keyDown(screen.getByRole("separator", { name: "Resize notes" }), { key: "ArrowDown" })
		expect(writes).toEqual([])
		view.unmount()

		expect(writes).toHaveLength(1)
		expect(presentationNotesLayout()).toEqual(writes[0]?.value)
	})
})
