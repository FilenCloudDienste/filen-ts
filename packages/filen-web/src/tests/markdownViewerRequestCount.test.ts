// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ChangeEvent } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { downloadFileBytes, cancelPreviewDownload } = vi.hoisted(() => ({
	downloadFileBytes: vi.fn<(file: unknown, token: string) => Promise<Uint8Array>>(),
	cancelPreviewDownload: vi.fn(() => Promise.resolve())
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: { downloadFileBytes, downloadLinkedFileBytesAnon: vi.fn(), cancelPreviewDownload },
	threadCount: () => 1
}))

vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }))

// CodeMirror's own view needs layout jsdom lacks; a textarea keeps the real CodeMirrorSource buffer,
// dirty and contentRef logic under test while standing in for the editor surface.
vi.mock("@uiw/react-codemirror", () => ({
	default: (props: { value: string; readOnly: boolean; "aria-label": string; onChange?: (value: string) => void }) =>
		createElement("textarea", {
			"aria-label": props["aria-label"],
			value: props.value,
			readOnly: props.readOnly,
			onChange: (event: ChangeEvent<HTMLTextAreaElement>) => props.onChange?.(event.target.value)
		})
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import MarkdownViewer from "@/features/preview/components/markdownViewer"

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
		const contentRef = { current: null as string | null }
		const props = { alt: ALT, editable: true, onDirtyChange: setPreviewDirty, contentRef }
		const { rerender } = render(createElement(MarkdownViewer, { key: "before", item: mdFile("before"), ...props }))

		await screen.findByRole("heading", { name: "Original heading" })
		toggle("View source")
		const editor = await sourceEditor()
		expect(editor.readOnly).toBe(false)
		await waitFor(() => {
			expect(contentRef.current).toBe(ORIGINAL)
		})
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(false)

		fireEvent.change(editor, { target: { value: SAVED } })
		await waitFor(() => {
			expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
		})
		expect(contentRef.current).toBe(SAVED)

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
