// @vitest-environment jsdom

import { createRef } from "react"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { EditorView } from "@codemirror/view"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import type { TextBuffer } from "@/features/preview/lib/textFile"

// The text editor's encoding menu over a real viewer and editor: what was detected, Reopen with another encoding
// (never over unsaved edits, never remembered), Convert to UTF-8 (a read-only file becomes editable and dirty), and a
// save refused for a character the file's encoding cannot hold. Converting a lossy read asks first.

const { previewBytes, frames, detected } = vi.hoisted(() => ({
	// What the detector guesses for bytes that are not Unicode (its wasm is not loaded here).
	detected: { current: null as string | null, asked: 0 },
	previewBytes: { current: new Uint8Array(0) },
	frames: [] as FrameRequestCallback[]
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/lib/encodingGuess", () => ({
	guessLegacyEncoding: () => {
		detected.asked++

		return Promise.resolve(detected.current)
	}
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: previewBytes.current, refetch: vi.fn() })
}))

const { TextViewer } = await import("@/features/preview/components/textViewer")
const { narrowItem } = await import("@/features/drive/lib/item")
const { PREVIEW_ACTIONS } = await import("@/features/preview/lib/keymap")
const { registerAction } = await import("@/lib/keymap/registry")

beforeAll(() => {
	for (const def of PREVIEW_ACTIONS) {
		registerAction(def)
	}
})

beforeEach(() => {
	frames.length = 0
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
	vi.stubGlobal("cancelAnimationFrame", () => undefined)
})

afterEach(() => {
	cleanup()
	detected.current = null
	vi.unstubAllGlobals()
})

function named(name: string) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

function editorView(): EditorView {
	const dom = document.querySelector<HTMLElement>(".cm-editor")
	const view = dom === null ? null : EditorView.findFromDOM(dom)

	if (view === null) throw new Error("no editor view")

	return view
}

async function mount(bytes: Uint8Array<ArrayBuffer>, readAs?: string) {
	previewBytes.current = bytes

	const contentRef = createRef<TextBuffer | null>() as { current: TextBuffer | null }
	const onDirtyChange = vi.fn<(dirty: boolean) => void>()
	const onTextState = vi.fn()

	render(
		<TextViewer
			item={named("notes.txt")}
			alt="notes.txt"
			editable
			contentRef={contentRef}
			onDirtyChange={onDirtyChange}
			onTextState={onTextState}
			{...(readAs === undefined ? {} : { readAs })}
		/>
	)

	// Bytes that are not Unicode wait for the detector first.
	await screen.findByRole("button", { name: /^Encoding: / })

	return { contentRef, onDirtyChange, onTextState }
}

async function openMenu(name: RegExp): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name }))
	await screen.findByRole("menu")
}

// "Grüße" as UTF-8 with a stray byte: lossy UTF-8, which a save would change.
const STRAY = Uint8Array.of(...new TextEncoder().encode("Grüße, Köln"), 0xff)
// "При" in windows-1251, which the English codepage reads as "Ïðè".
const CYRILLIC = Uint8Array.of(0xcf, 0xf0, 0xe8)

describe("the encoding menu", () => {
	it("reads bytes that are not Unicode with the detector's guess", async () => {
		detected.current = "windows-1251"
		const { onTextState } = await mount(CYRILLIC)

		expect(editorView().state.doc.toString()).toBe("При")
		await openMenu(/Encoding: Windows-1251/)
		expect(screen.getByText("Detected: Windows-1251")).toBeTruthy()
		expect(onTextState).toHaveBeenLastCalledWith({ writable: true, encoding: "windows-1251", readEncoding: "windows-1251" })
	})

	// A version this open saved reads in the codepage it was saved in: a new guess could differ, and the next save would
	// then mix two codepages in one file.
	it("reads a version known to be in a codepage in it, without asking the detector", async () => {
		detected.current = "windows-1251"
		detected.asked = 0
		await mount(CYRILLIC, "koi8-r")

		expect(detected.asked).toBe(0)
		expect(editorView().state.doc.toString()).toBe(new TextDecoder("koi8-r").decode(CYRILLIC))
		expect(screen.getByRole("button", { name: "Encoding: KOI8-R" })).toBeTruthy()
	})

	// The detector names GBK, which the menu lists as GB18030 (the same bytes read the same way).
	it("checks the menu's own label for the detector's name", async () => {
		detected.current = "gb18030"
		await mount(Uint8Array.of(0xc4, 0xe3, 0xba, 0xc3))

		await openMenu(/Encoding: GB18030/)
		fireEvent.click(screen.getByRole("menuitem", { name: "Reopen with encoding" }))
		expect((await screen.findByRole("menuitemradio", { name: "Chinese Simplified (GB18030)" })).getAttribute("aria-checked")).toBe(
			"true"
		)
	})

	it("says what was detected and reopens the held bytes with another encoding", async () => {
		const { onTextState } = await mount(CYRILLIC)

		expect(editorView().state.doc.toString()).toBe("Ïðè")
		await openMenu(/Encoding: Windows-1252/)
		expect(screen.getByText("Detected: Windows-1252")).toBeTruthy()

		fireEvent.click(screen.getByRole("menuitem", { name: "Reopen with encoding" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Cyrillic (Windows-1251)" }))

		expect(editorView().state.doc.toString()).toBe("При")
		expect(screen.getByRole("button", { name: /Encoding: Windows-1251/ })).toBeTruthy()
		expect(onTextState).toHaveBeenLastCalledWith({ writable: true, encoding: "windows-1251", readEncoding: "windows-1251" })
	})

	it("converts a lossy read to UTF-8 only once the loss is accepted: then editable, and unsaved until saved", async () => {
		const { contentRef, onDirtyChange, onTextState } = await mount(STRAY)

		expect(onTextState).toHaveBeenLastCalledWith({ writable: false, encoding: "utf-8", readEncoding: "utf-8" })
		expect(screen.getByText("Read-only")).toBeTruthy()

		await openMenu(/Encoding: UTF-8/)
		fireEvent.click(screen.getByRole("menuitem", { name: "Convert to UTF-8" }))

		const warning = await screen.findByRole("alertdialog", { name: "Replace unreadable characters?" })

		expect(warning.textContent).toContain("can't be read as UTF-8")
		expect(onTextState).toHaveBeenLastCalledWith({ writable: false, encoding: "utf-8", readEncoding: "utf-8" })

		fireEvent.click(screen.getByRole("button", { name: "Convert to UTF-8" }))

		expect(onTextState).toHaveBeenLastCalledWith({ writable: true, encoding: "utf-8", readEncoding: "utf-8" })
		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		expect(screen.queryByText("Read-only")).toBeNull()
		expect(screen.getByText("UTF-8 (unsaved)")).toBeTruthy()
		expect(contentRef.current?.bytes()).toEqual({ bytes: new TextEncoder().encode("Grüße, Köln\uFFFD") })
	})

	it("does not offer Convert for a file that is UTF-8 as is", async () => {
		await mount(new TextEncoder().encode("plain"))

		await openMenu(/Encoding: UTF-8/)
		expect(screen.queryByRole("menuitem", { name: "Convert to UTF-8" })).toBeNull()
	})

	it("refuses a save the encoding cannot hold, and converts from the refusal", async () => {
		const { contentRef, onDirtyChange } = await mount(Uint8Array.of(0x63, 0x61, 0x66, 0xe9))
		const view = editorView()

		act(() => {
			view.dispatch({ changes: { from: view.state.doc.length, insert: "☃" } })
		})

		const encoded = contentRef.current?.bytes()

		expect(encoded).toEqual({ unencodable: { line: 1, column: 5, char: "☃" } })

		// What the overlay does with a refused save.
		act(() => {
			if (encoded !== undefined && "unencodable" in encoded) {
				contentRef.current?.explain(encoded.unencodable)
			}
		})

		expect(await screen.findByText(/Windows-1252 has no character “☃” \(line 1, column 5\)/)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Convert to UTF-8" }))

		expect(onDirtyChange).toHaveBeenLastCalledWith(true)
		// Nothing was lost in the read: no warning.
		expect(screen.queryByRole("alertdialog", { name: "Replace unreadable characters?" })).toBeNull()
		expect(contentRef.current?.bytes()).toEqual({ bytes: new TextEncoder().encode("café☃") })
	})

	it("blocks Reopen while there are unsaved edits", async () => {
		await mount(CYRILLIC)
		const view = editorView()

		act(() => {
			view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } })
		})

		await openMenu(/Encoding: Windows-1252/)
		expect(screen.getByRole("menuitem", { name: "Reopen with encoding" }).getAttribute("aria-disabled")).toBe("true")
	})
})
