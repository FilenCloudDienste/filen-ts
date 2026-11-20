// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { createElement, useRef } from "react"

const { stored, kvGetJson, kvSetJson } = vi.hoisted(() => {
	const stored = new Map<string, unknown>()

	return {
		stored,
		kvGetJson: vi.fn((key: string) => Promise.resolve(stored.get(key) ?? null)),
		kvSetJson: vi.fn(() => Promise.resolve())
	}
})

vi.mock("@/lib/storage/adapter", () => ({ kvGetJson, kvSetJson }))

import "@/lib/i18n"
import { EmojiPicker } from "@/features/chats/components/thread/emojiPicker"
import { useEmojiRecents } from "@/features/chats/store/useEmojiRecents"
import { isEmojiSetParsed } from "@/features/chats/lib/emoji"

const onPick = vi.fn<(text: string) => void>()

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
	useEmojiRecents.setState({ recents: [], skinTone: 0, skinToneChosen: false })
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
	// First in the file: the emoji data and the stored skin tone are read once per module instance.
	it("splits the emoji data only when it opens, and reads the remembered skin tone then", async () => {
		stored.set("chats.emojiSkinTone.v1", 2)
		render(createElement(Host))

		expect(isEmojiSetParsed()).toBe(false)
		expect(kvGetJson).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Emoji" }))
		fireEvent.click(await screen.findByRole("tab", { name: "People & body" }))

		expect(isEmojiSetParsed()).toBe(true)
		await waitFor(() => {
			expect(
				within(screen.getByRole("grid", { name: "People & body" })).getByRole("gridcell", { name: "waving hand" }).textContent
			).toBe("👋🏼")
		})
		expect(screen.getByRole("button", { name: "Skin tone" }).textContent).toBe("✋🏼")
		stored.clear()
	})

	it("opens on the first category when nothing was used yet, with a tab per category", async () => {
		await openPicker()

		expect(screen.getByRole("tab", { name: "Smileys & emotion", selected: true })).toBeTruthy()
		expect(screen.getAllByRole("tab")).toHaveLength(11)
		expect(screen.getByRole("tab", { name: "Filen emoji" })).toBeTruthy()
		expect(
			within(screen.getByRole("grid", { name: "Smileys & emotion" })).getByRole("gridcell", { name: "grinning face" })
		).toBeTruthy()
	})

	it("offers the flags", async () => {
		const search = await openPicker()

		fireEvent.click(screen.getByRole("tab", { name: "Flags" }))
		expect(within(screen.getByRole("grid", { name: "Flags" })).getByRole("gridcell", { name: "chequered flag" }).textContent).toBe("🏁")

		fireEvent.change(search, { target: { value: "germany" } })
		expect(within(screen.getByRole("grid", { name: "Search results" })).getByRole("gridcell", { name: "flag: Germany" })).toBeTruthy()
	})

	it("finds an emoji by a keyword its name does not hold", async () => {
		const search = await openPicker()

		fireEvent.change(search, { target: { value: "cheerful" } })

		expect(within(screen.getByRole("grid", { name: "Search results" })).getByRole("gridcell", { name: "grinning face" })).toBeTruthy()
	})

	it("applies the chosen skin tone to what it shows and inserts, remembers it, and keeps recents untoned", async () => {
		const search = await openPicker()

		fireEvent.click(screen.getByRole("button", { name: "Skin tone" }))
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Skin tone" })).getByRole("radio", { name: "Medium" }))

		expect(useEmojiRecents.getState().skinTone).toBe(3)
		expect(kvSetJson).toHaveBeenCalledWith("chats.emojiSkinTone.v1", 3)
		expect(screen.queryByRole("radiogroup")).toBeNull()
		expect(document.activeElement).toBe(search)

		fireEvent.change(search, { target: { value: "waving hand" } })

		const grid = screen.getByRole("grid", { name: "Search results" })

		expect(within(grid).getByRole("gridcell", { name: "waving hand" }).textContent).toBe("👋🏽")

		fireEvent.keyDown(search, { key: "Enter" })

		expect(onPick).toHaveBeenCalledWith("👋🏽")
		expect(useEmojiRecents.getState().recents).toEqual(["👋"])
	})

	it("searches, moves into the grid with ArrowDown and picks with Enter, then returns focus to the message field", async () => {
		const search = await openPicker()

		fireEvent.change(search, { target: { value: "rocket" } })

		const grid = screen.getByRole("grid", { name: "Search results" })

		expect(within(grid).getByRole("gridcell", { name: "rocket" })).toBeTruthy()

		fireEvent.keyDown(search, { key: "ArrowDown" })
		expect(document.activeElement).toBe(grid)

		fireEvent.keyDown(grid, { key: "Enter" })

		expect(onPick).toHaveBeenCalledWith("🚀")
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

		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("grinning face").id)

		fireEvent.keyDown(grid, { key: "ArrowRight" })
		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("grinning face with big eyes").id)

		// Eight columns: one row down from the second cell is the tenth.
		fireEvent.keyDown(grid, { key: "ArrowDown" })
		expect(grid.getAttribute("aria-activedescendant")).toBe(cell("upside-down face").id)
		expect(cell("upside-down face").getAttribute("aria-selected")).toBe("true")
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
