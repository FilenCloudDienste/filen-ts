// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createElement, useRef } from "react"
import type { EmojiSuggestion } from "@/features/chats/lib/emoji"

const { kvGetJson, kvSetJson } = vi.hoisted(() => ({
	kvGetJson: vi.fn(() => Promise.resolve(null)),
	kvSetJson: vi.fn(() => Promise.resolve())
}))

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson }))

import "@/lib/i18n"
import { EmojiPicker } from "@/features/chats/components/thread/emojiPicker"
import { useEmojiRecents } from "@/features/chats/store/useEmojiRecents"

const onPick = vi.fn<(item: EmojiSuggestion) => void>()

function Host() {
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)

	return (
		<div>
			<textarea
				ref={textareaRef}
				aria-label="Message"
			/>
			<EmojiPicker
				returnFocusRef={textareaRef}
				onPick={onPick}
			/>
		</div>
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	useEmojiRecents.setState({ recents: [] })
	// jsdom lays nothing out; the virtualizer reads the scroller's size from these.
	vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(256)
	vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(304)
})

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

async function openPicker(): Promise<HTMLElement> {
	render(createElement(Host))
	fireEvent.click(screen.getByRole("button", { name: "Emoji" }))

	const search = await screen.findByRole("searchbox", { name: "Search emoji" })

	await waitFor(() => {
		expect(document.activeElement).toBe(search)
	})

	return search
}

describe("EmojiPicker", () => {
	it("opens on the first category when nothing was used yet, with a tab per category", async () => {
		await openPicker()

		expect(screen.getByRole("tab", { name: "Smileys & emotion", selected: true })).toBeTruthy()
		expect(screen.getAllByRole("tab")).toHaveLength(10)
		expect(screen.getByRole("tab", { name: "Filen emoji" })).toBeTruthy()
		expect(within(screen.getByRole("grid", { name: "Smileys & emotion" })).getByRole("gridcell", { name: "smile" })).toBeTruthy()
	})

	it("searches, moves into the grid with ArrowDown and picks with Enter, then returns focus to the message field", async () => {
		const search = await openPicker()

		fireEvent.change(search, { target: { value: "rocket" } })

		const grid = screen.getByRole("grid", { name: "Search results" })

		expect(within(grid).getByRole("gridcell", { name: "rocket" })).toBeTruthy()

		fireEvent.keyDown(search, { key: "ArrowDown" })
		expect(document.activeElement).toBe(grid)

		fireEvent.keyDown(grid, { key: "Enter" })

		expect(onPick).toHaveBeenCalledWith({ kind: "standard", name: "rocket", char: "🚀" })
		expect(useEmojiRecents.getState().recents[0]).toBe("🚀")
		expect(kvSetJson).toHaveBeenCalledWith("chats.emojiRecents.v1", ["🚀"])

		await waitFor(() => {
			expect(screen.queryByRole("searchbox")).toBeNull()
			expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }))
		})
	})

	it("moves the active cell with the arrow keys", async () => {
		await openPicker()

		const grid = screen.getByRole("grid", { name: "Smileys & emotion" })
		const cell = (name: string) => within(grid).getByRole("gridcell", { name })

		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("smile").id)

		fireEvent.keyDown(grid, { key: "ArrowRight" })
		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("smiley").id)

		// Eight columns: one row down from the second cell is the tenth.
		fireEvent.keyDown(grid, { key: "ArrowDown" })
		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("upside down face").id)
		expect(cell("upside down face").getAttribute("aria-selected")).toBe("true")
	})

	it("opens on the recently used tab once something was used", async () => {
		useEmojiRecents.setState({ recents: ["🚀"] })
		await openPicker()

		expect(screen.getByRole("tab", { name: "Recently used", selected: true })).toBeTruthy()
		expect(within(screen.getByRole("grid", { name: "Recently used" })).getByRole("gridcell", { name: "rocket" })).toBeTruthy()
	})

	it("starts a new list at its top after a tab switch or a search edit", async () => {
		const search = await openPicker()

		fireEvent.click(screen.getByRole("tab", { name: "Filen emoji" }))

		const scrolled = screen.getByRole("grid", { name: "Filen emoji" }).parentElement

		if (scrolled === null) {
			throw new Error("grid has no scroller")
		}

		// jsdom keeps no scroll offset; pin one on this scroller as if the user had scrolled the long custom tab.
		Object.defineProperty(scrolled, "scrollTop", { value: 2000, configurable: true })
		fireEvent.change(search, { target: { value: "rocket" } })

		const results = screen.getByRole("grid", { name: "Search results" })

		expect(results.parentElement).not.toBe(scrolled)
		expect(results.parentElement?.scrollTop).toBe(0)
		expect(within(results).getByRole("gridcell", { name: "rocket" })).toBeTruthy()

		fireEvent.click(screen.getByRole("tab", { name: "Smileys & emotion" }))
		expect(screen.getByRole("grid", { name: "Smileys & emotion" }).parentElement).not.toBe(results.parentElement)
	})

	it("goes back to the selected tab's list when that tab is clicked during a search", async () => {
		const search = await openPicker()

		fireEvent.change(search, { target: { value: "rocket" } })
		expect(screen.getByRole("grid", { name: "Search results" })).toBeTruthy()

		fireEvent.click(screen.getByRole("tab", { name: "Smileys & emotion" }))

		expect((search as HTMLInputElement).value).toBe("")
		expect(screen.getByRole("grid", { name: "Smileys & emotion" })).toBeTruthy()
	})

	it("closes on Escape and gives focus back to the message field", async () => {
		const search = await openPicker()

		fireEvent.keyDown(search, { key: "Escape" })

		await waitFor(() => {
			expect(screen.queryByRole("searchbox")).toBeNull()
			expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }))
		})
		expect(onPick).not.toHaveBeenCalled()
	})
})
