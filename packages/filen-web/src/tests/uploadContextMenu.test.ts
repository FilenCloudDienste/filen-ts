// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"

// The pickers' upload paths reach the SDK worker, which is unresolvable under vitest; no case here
// starts an upload. The HEIC preference is a kv-backed query with no provider in this harness.
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
// The Paste entry's shortcut badge, reduced to its action id (the registry isn't loaded here).
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useHeicUploadConvertPreferenceQuery: () => ({ data: false, refetch: vi.fn() })
}))

import "@/lib/i18n"
import { UploadContextMenu, UploadMenu } from "@/features/drive/components/uploadMenu"
import type { DrivePasteAction } from "@/features/drive/hooks/useDriveClipboard"

afterEach(() => {
	cleanup()
})

// A listbox stand-in: a blank wrapper, one option with a child, and a control — the three kinds of
// target a right-click inside the listing can land on.
function surface() {
	return createElement(
		"div",
		{ role: "listbox", "data-testid": "surface" },
		createElement(
			"div",
			{ role: "presentation", "data-testid": "blank" },
			createElement("div", { role: "option", "aria-selected": false }, createElement("span", { "data-testid": "row-name" }, "a.txt")),
			createElement("button", { type: "button" }, "Control")
		)
	)
}

function renderContextMenu(options: { disabled?: boolean; paste?: DrivePasteAction } = {}) {
	const onOpen = vi.fn()

	render(
		createElement(UploadContextMenu, {
			parentUuid: null,
			disabled: options.disabled ?? false,
			openPreview: vi.fn(),
			paste: options.paste,
			onOpen,
			render: surface()
		})
	)

	return { onOpen }
}

// fireEvent returns only whether the default survived; the event itself is what shows whether the
// browser's own menu was left alone.
function rightClick(target: Element): Event {
	const event = createEvent.contextMenu(target, { clientX: 20, clientY: 20 })

	act(() => {
		fireEvent(target, event)
	})

	return event
}

function menuLabels(): string[] {
	return Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'), item => item.textContent)
}

describe("UploadContextMenu", () => {
	it("opens on the surface's empty space with exactly the toolbar menu's entries", () => {
		render(createElement(UploadMenu, { parentUuid: null, openPreview: vi.fn() }))
		fireEvent.click(screen.getByRole("button", { name: "Upload" }))

		const toolbarEntries = menuLabels()

		cleanup()

		const { onOpen } = renderContextMenu()

		rightClick(screen.getByTestId("blank"))

		expect(toolbarEntries).toEqual(["Upload files", "Upload directory", "New text file", "Convert HEIC/HEIF to JPG"])
		expect(menuLabels()).toEqual(toolbarEntries)
		expect(onOpen).toHaveBeenCalledOnce()
	})

	it("opens on the surface element itself (the space below the last row)", () => {
		const { onOpen } = renderContextMenu()

		rightClick(screen.getByTestId("surface"))

		expect(menuLabels()).toHaveLength(4)
		expect(onOpen).toHaveBeenCalledOnce()
	})

	it("stays closed over an item, leaving that right-click to the item's own menu", () => {
		const { onOpen } = renderContextMenu()

		rightClick(screen.getByTestId("row-name"))

		expect(menuLabels()).toEqual([])
		expect(onOpen).not.toHaveBeenCalled()
	})

	it("stays closed over a control and leaves the browser's own menu in place there", () => {
		const { onOpen } = renderContextMenu()

		const event = rightClick(screen.getByRole("button", { name: "Control" }))

		expect(menuLabels()).toEqual([])
		expect(onOpen).not.toHaveBeenCalled()
		expect(event.defaultPrevented).toBe(false)
	})

	it("offers Paste in both menus, greyed out while there is nothing to paste here", () => {
		const run = vi.fn()

		render(createElement(UploadMenu, { parentUuid: null, openPreview: vi.fn(), paste: { enabled: false, run } }))
		fireEvent.click(screen.getByRole("button", { name: "Upload" }))

		const toolbarPaste = screen.getByRole("menuitem", { name: /^Paste/ })

		expect(menuLabels()).toEqual(["Upload files", "Upload directory", "New text file", "Paste drive.paste", "Convert HEIC/HEIF to JPG"])
		expect(toolbarPaste.getAttribute("aria-disabled")).toBe("true")

		cleanup()
		renderContextMenu({ paste: { enabled: true, run } })
		rightClick(screen.getByTestId("blank"))
		fireEvent.click(screen.getByRole("menuitem", { name: /^Paste/ }))

		expect(run).toHaveBeenCalledOnce()
	})

	it("does nothing where the toolbar menu is disabled, so empty space behaves as before", () => {
		const { onOpen } = renderContextMenu({ disabled: true })

		const event = rightClick(screen.getByTestId("blank"))

		expect(menuLabels()).toEqual([])
		expect(onOpen).not.toHaveBeenCalled()
		expect(event.defaultPrevented).toBe(false)
	})
})
