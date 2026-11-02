// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { useEditorLayerKeys } from "@/lib/keymap/editorLayerKeys"

// An editor's keys in the layer it is shown in: pressed in the editor, or on anything else in that layer (the preview
// overlay keeps focus on itself after a click in Safari and macOS Firefox), but never in a native field outside the
// editor, which owns the key, nor in a dialog over the editor.

function Overlay({ onKey }: { onKey: (key: string) => void }) {
	const root = useRef<HTMLDivElement | null>(null)

	useEditorLayerKeys(root, event => {
		onKey(event.key)
	})

	return (
		<div
			role="dialog"
			data-open=""
			tabIndex={-1}
			aria-label="Overlay"
		>
			<input aria-label="Rename" />
			<button type="button">Download</button>
			<div
				ref={root}
				aria-label="Editor"
				tabIndex={-1}
			>
				<span aria-label="In editor" />
			</div>
			<div
				role="dialog"
				data-open=""
				aria-label="Over the editor"
			>
				<button type="button">Inner</button>
			</div>
		</div>
	)
}

afterEach(() => {
	cleanup()
})

describe("keys for an editor in its layer", () => {
	it("belong to the editor from the overlay, its buttons and the editor, not from a field or a dialog over it", () => {
		render(<Overlay onKey={() => undefined} />)

		const editor = screen.getByLabelText("Editor")

		expect(keyForEditor(editor, screen.getByRole("dialog", { name: "Overlay" }))).toBe(true)
		expect(keyForEditor(editor, screen.getByRole("button", { name: "Download" }))).toBe(true)
		expect(keyForEditor(editor, screen.getByLabelText("In editor"))).toBe(true)
		expect(keyForEditor(editor, screen.getByRole("textbox", { name: "Rename" }))).toBe(false)
		expect(keyForEditor(editor, screen.getByRole("button", { name: "Inner" }))).toBe(false)
		expect(keyForEditor(editor, null)).toBe(false)
	})

	it("reaches the editor's handler for a key pressed on the overlay itself, once, and never from a field", () => {
		const onKey = vi.fn()

		render(<Overlay onKey={onKey} />)

		fireEvent.keyDown(screen.getByRole("dialog", { name: "Overlay" }), { key: "F6" })
		fireEvent.keyDown(screen.getByRole("button", { name: "Download" }), { key: "F5" })
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename" }), { key: "f", ctrlKey: true })
		fireEvent.keyDown(screen.getByRole("button", { name: "Inner" }), { key: "F6" })
		// The editor's own keys go through its own handlers, not this one.
		fireEvent.keyDown(screen.getByLabelText("In editor"), { key: "F6" })

		expect(onKey.mock.calls).toEqual([["F6"], ["F5"]])
	})
})
