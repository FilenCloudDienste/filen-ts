// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, render } from "@testing-library/react"

// <Kbd> labels a binding by the keys a user presses: physical keys, named for the layout in use (a German keyboard
// here, through Keyboard.getLayoutMap()), off a Mac. The stored record holds an older spelling, which the load
// migrates.
const GERMAN = new Map([
	["KeyY", "z"],
	["KeyZ", "y"],
	["BracketLeft", "ü"],
	["Comma", ","],
	["Equal", "´"]
])

// jsdom's navigator is the window's own; a stubbed global would not replace it.
Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true })
Object.defineProperty(navigator, "keyboard", { value: { getLayoutMap: () => Promise.resolve(GERMAN) }, configurable: true })

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve({ "presentation.text.growFont": "mod+shift+.", "editor.find": "mod+y" }),
	kvSetJson: () => Promise.resolve()
}))

const { registerAllActions } = await import("@/lib/keymap/actions")
const { keymapOverridesLoaded } = await import("@/lib/keymap/registry")
const { Kbd } = await import("@/lib/keymap/kbd")

registerAllActions()
await keymapOverridesLoaded()

async function labels(action: string): Promise<(string | null)[][]> {
	const { container, unmount } = render(<Kbd action={action} />)

	// The layout map resolves asynchronously.
	await act(() => Promise.resolve())

	const groups = [...container.querySelectorAll("[data-slot=kbd-group]")].map(group =>
		[...group.querySelectorAll("[data-slot=kbd]")].map(key => key.textContent)
	)

	unmount()

	return groups
}

describe("<Kbd>", () => {
	it("names each key by the layout's character, one group per alternative", async () => {
		expect(await labels("presentation.text.shrinkFont")).toEqual([["Ctrl", "Shift", ","]])
		expect(await labels("presentation.objects.sendBackward")).toEqual([["Ctrl", "Ü"]])
		expect(await labels("drive.trash")).toEqual([["Del"], ["⌫"]])
		expect(await labels("presentation.zoomIn")).toEqual([
			["Ctrl", "´"],
			["Ctrl", "Shift", "´"],
			["Ctrl", "Num +"]
		])
	})

	it("shows a migrated override and a key recorded on the layout", async () => {
		expect(await labels("presentation.text.growFont")).toEqual([["Ctrl", "Shift", "."]])
		// Recorded on the German key printed Z: the token is "y", the label Z.
		expect(await labels("editor.find")).toEqual([["Ctrl", "Z"]])
	})
})
