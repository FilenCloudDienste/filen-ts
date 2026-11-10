// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { DownloadIcon } from "lucide-react"
import "@/lib/i18n"

// drive.downloadAs's default, as the registry resolves it, without loading its storage.
vi.mock("@/lib/keymap/registry", () => ({
	isRecordingCombo: () => false,
	useComboFor: (id: string) => (id === "drive.downloadAs" ? "mod+shift+s" : ""),
	comboFor: () => "",
	subscribeBindings: () => () => undefined
}))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))

const { BulkActionMenuButton } = await import("@/components/selectionActionBar")
const { SearchInput } = await import("@/features/drive/components/searchInput")

function pressDownloadAs(): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "S",
		code: "KeyS",
		shiftKey: true,
		ctrlKey: true,
		metaKey: true
	})

	act(() => {
		document.body.dispatchEvent(event)
	})

	return event
}

function menuButton(disabled: boolean) {
	return createElement(BulkActionMenuButton, {
		icon: DownloadIcon,
		label: "Download as",
		disabled,
		kbdAction: "drive.downloadAs",
		children: createElement("div", { role: "menuitem" }, "PDF")
	})
}

afterEach(() => {
	cleanup()
	document.body.replaceChildren()
})

describe("BulkActionMenuButton — its key", () => {
	it("opens the menu, cancelling the browser's own use of the key", () => {
		render(menuButton(false))

		expect(screen.queryByText("PDF")).toBeNull()
		expect(pressDownloadAs().defaultPrevented).toBe(true)
		expect(screen.queryByText("PDF")).not.toBeNull()
	})

	it("does nothing while the button is disabled", () => {
		render(menuButton(true))

		expect(pressDownloadAs().defaultPrevented).toBe(false)
		expect(screen.queryByText("PDF")).toBeNull()
	})
})

describe("SearchInput — ArrowDown", () => {
	function renderSearch(onFocusList: () => void) {
		render(
			createElement(SearchInput, {
				action: "drive.search",
				label: "Search",
				value: "",
				onChange: vi.fn(),
				onClear: vi.fn(),
				onFocusList
			})
		)

		return screen.getByRole("searchbox")
	}

	it("hands focus to the list it filters", () => {
		const onFocusList = vi.fn()
		const box = renderSearch(onFocusList)

		fireEvent.keyDown(box, { key: "ArrowDown" })

		expect(onFocusList).toHaveBeenCalledOnce()
	})

	it("leaves a chord with ArrowDown, and a composing input method's, alone", () => {
		const onFocusList = vi.fn()
		const box = renderSearch(onFocusList)

		fireEvent.keyDown(box, { key: "ArrowDown", shiftKey: true })
		fireEvent.keyDown(box, { key: "ArrowDown", altKey: true })
		fireEvent.keyDown(box, { key: "ArrowDown", isComposing: true })

		expect(onFocusList).not.toHaveBeenCalled()
	})
})
