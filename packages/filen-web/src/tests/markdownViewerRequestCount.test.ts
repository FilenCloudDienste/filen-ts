// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ChangeEvent } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import type { Extension } from "@codemirror/state"
import "@/lib/i18n"

const { downloadFileBytes, cancelPreviewDownload } = vi.hoisted(() => ({
	downloadFileBytes: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownload: vi.fn(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon: vi.fn(), cancelPreviewDownload },
	threadCount: () => 1
}))

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }), resolveTheme: () => "light" }))

// CodeMirror's own view needs layout jsdom lacks; a textarea stands in for the editor surface over a
// detached EditorView carrying CodeMirrorSource's real extensions, so its buffer, dirty and contentRef
// logic stays under test. Uncontrolled, like the editor: `value` seeds it, and the typed buffer lives in
// it. The view is handed over once, as @uiw does.
vi.mock("@uiw/react-codemirror", async () => {
	const { Annotation, EditorState } = await import("@codemirror/state")
	const { EditorView } = await import("@codemirror/view")
	const { useEffectEvent, useLayoutEffect, useState } = await import("react")

	interface FakeProps {
		value: string
		readOnly: boolean
		"aria-label": string
		extensions: Extension[]
		onCreateEditor?: (view: InstanceType<typeof EditorView>) => void
	}

	function FakeCodeMirror(props: FakeProps) {
		const [view] = useState(() => new EditorView({ state: EditorState.create({ doc: props.value, extensions: props.extensions }) }))
		const created = useEffectEvent(() => {
			props.onCreateEditor?.(view)
		})

		useLayoutEffect(() => {
			created()

			return () => {
				view.destroy()
			}
		}, [view])

		return createElement("textarea", {
			"aria-label": props["aria-label"],
			defaultValue: props.value,
			readOnly: props.readOnly,
			onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
				view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: event.target.value } })
			}
		})
	}

	return {
		// The source's update listener skips @uiw's own value-sync transactions by this annotation.
		ExternalChange: Annotation.define<boolean>(),
		oneDarkHighlightStyle: (await import("@codemirror/language")).HighlightStyle.define([]),
		default: FakeCodeMirror
	}
})

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import MarkdownViewer from "@/features/preview/components/markdownViewer"
import { PREVIEW_ACTIONS } from "@/features/preview/lib/keymap"
import { registerAction } from "@/lib/keymap/registry"

const ALT = "readme.md"
const ORIGINAL = "# Original heading\n\nbody"
const SAVED = "# Saved heading\n\nbody"

function mdFile(label: string): DriveItem {
	const file: File = {
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000",
		size: 32n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: ALT, mime: "text/markdown", modified: 1_700_000_000_000n, size: 32n, key: "k", version: 2 }
		}
	}

	return narrowItem(file)
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

function toggle(name: "View source" | "View rendered"): void {
	fireEvent.click(screen.getByRole("button", { name }))
}

async function sourceEditor(): Promise<HTMLTextAreaElement> {
	return await screen.findByRole("textbox", { name: ALT })
}

// The viewer and its editor bind the editor shortcuts, which the app registers at boot.
beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	downloadFileBytes.mockReset()
	usePreviewUnsavedGuardStore.getState().clear()
})

afterEach(() => {
	cleanup()
})

describe("MarkdownViewer request count", () => {
	it("rendered -> source -> rendered -> source reuses the one download", async () => {
		downloadFileBytes.mockResolvedValue(bytes(ORIGINAL))
		render(createElement(MarkdownViewer, { item: mdFile("readonly"), alt: ALT }))

		await screen.findByRole("heading", { name: "Original heading" })
		toggle("View source")
		expect((await sourceEditor()).value).toBe(ORIGINAL)
		expect((await sourceEditor()).readOnly).toBe(true)

		toggle("View rendered")
		await screen.findByRole("heading", { name: "Original heading" })
		toggle("View source")
		expect((await sourceEditor()).value).toBe(ORIGINAL)

		expect(downloadFileBytes).toHaveBeenCalledTimes(1)
	})

	it("source mode keeps editing, dirty tracking and the save buffer, and shows the saved text after a save", async () => {
		// Served by uuid, so the saved revision's bytes only ever come from the rotated item.
		downloadFileBytes.mockImplementation(file =>
			Promise.resolve(bytes((file as { uuid: string }).uuid.startsWith("after") ? SAVED : ORIGINAL))
		)
		const contentRef = { current: null as (() => string) | null }
		const props = { alt: ALT, editable: true, onDirtyChange: setPreviewDirty, contentRef }
		const { rerender } = render(createElement(MarkdownViewer, { key: "before", item: mdFile("before"), ...props }))

		await screen.findByRole("heading", { name: "Original heading" })
		toggle("View source")
		const editor = await sourceEditor()
		expect(editor.readOnly).toBe(false)
		await waitFor(() => {
			expect(contentRef.current?.()).toBe(ORIGINAL)
		})
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)

		fireEvent.change(editor, { target: { value: SAVED } })
		await waitFor(() => {
			expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
		})
		expect(contentRef.current?.()).toBe(SAVED)

		// Locked while dirty: the unsaved buffer stays mounted.
		toggle("View rendered")
		expect((await sourceEditor()).value).toBe(SAVED)

		// The overlay's save success: dirty reset, buffer released, body re-keyed onto the rotated uuid.
		act(() => {
			setPreviewDirty(false)
		})
		contentRef.current = null
		rerender(createElement(MarkdownViewer, { key: "after", item: mdFile("after"), ...props }))

		await screen.findByRole("heading", { name: "Saved heading" })
		toggle("View source")
		expect((await sourceEditor()).value).toBe(SAVED)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)
		toggle("View rendered")
		await screen.findByRole("heading", { name: "Saved heading" })
		toggle("View source")
		expect((await sourceEditor()).value).toBe(SAVED)

		// One download per uuid, none per toggle.
		expect(downloadFileBytes).toHaveBeenCalledTimes(2)
	})
})
