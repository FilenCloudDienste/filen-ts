// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

// The item menu's "Open as text" through the drive dialog host, and the text viewer's binary guard.

const { overlayProps, previewBytes, archiveDialogs } = vi.hoisted(() => ({
	overlayProps: { current: null as Record<string, unknown> | null },
	previewBytes: { current: new Uint8Array() },
	archiveDialogs: [] as { name: string; props: Record<string, unknown> }[]
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => "/drive" }))
vi.mock("@/features/preview/components/previewOverlay", () => ({
	PreviewOverlay: (props: Record<string, unknown>) => {
		overlayProps.current = props

		return null
	}
}))
// The archive dialogs, reduced to which one the host mounted and with what.
vi.mock("@/features/drive/components/compressDialog", () => ({
	CompressDialog: (props: Record<string, unknown>) => {
		archiveDialogs.push({ name: "compress", props })

		return null
	}
}))
vi.mock("@/features/drive/components/extractDialog", () => ({
	ExtractDialog: (props: Record<string, unknown>) => {
		archiveDialogs.push({ name: "extract", props })

		return null
	}
}))
vi.mock("@/features/drive/components/extractDestinationDialog", () => ({
	ExtractDestinationDialog: (props: Record<string, unknown>) => {
		archiveDialogs.push({ name: "extractTo", props })

		return null
	}
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: previewBytes.current, refetch: vi.fn() })
}))
// The detector's wasm is not loaded here: what it guesses is set per test (null keeps the language's codepage).
const { detected } = vi.hoisted(() => ({ detected: { current: null as string | null } }))

vi.mock("@/features/preview/lib/encodingGuess", () => ({
	guessLegacyEncoding: () => Promise.resolve(detected.current)
}))
vi.mock("@/features/preview/components/codeSurface", () => ({
	CodeSurface: ({ file, editable }: { file: { text: string }; editable: boolean }) =>
		createElement("pre", { "data-testid": "source", "data-editable": String(editable) }, file.text)
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { TextViewer } from "@/features/preview/components/textViewer"
import { MarkdownViewer } from "@/features/preview/components/markdownViewer"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"
import { registerAllActions } from "@/lib/keymap/actions"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"

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
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

afterEach(() => {
	cleanup()
	detected.current = null
	overlayProps.current = null
	archiveDialogs.length = 0
})

describe("useDriveDialogHost — Open as text", () => {
	it("opens the preview overlay in its text mode on just that file", () => {
		const item = named("settings.bin")
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleDialogAction("openAsText", [item])
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(overlayProps.current).toMatchObject({ items: [item], index: 0, asText: true })
	})

	it("opens a normal preview without it", () => {
		const item = named("notes.txt")
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", hiddenNoticeApplies: false }))

		act(() => {
			result.current.openPreview([item], 0)
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(overlayProps.current).toMatchObject({ asText: false })
	})
})

describe("useDriveDialogHost — Compress and Extract", () => {
	it.each([
		["compress", "compress", "items"],
		["extract", "extract", "item"],
		["extractTo", "extractTo", "items"]
	] as const)("routes the item menu's %s to its dialog", (kind, name, prop) => {
		const item = named("backup.zip")
		const { result } = renderHook(() => useDriveDialogHost({ variant: "sharedIn", hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleDialogAction(kind, [item])
		})

		render(<>{result.current.renderActiveDialog()}</>)

		const routed = { variant: "sharedIn", [prop]: prop === "item" ? item : [item] }

		// The compress dialog takes its items as a drive subject.
		expect(archiveDialogs.at(-1)).toMatchObject({
			name,
			props: name === "compress" ? { subject: { kind: "drive", ...routed } } : routed
		})
	})

	it.each(["compress", "extractTo"] as const)("routes the bulk %s to its dialog on the whole selection", kind => {
		const selectedItems = [named("a.zip"), named("b.zip")]
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleDialogAction(kind, selectedItems)
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(archiveDialogs.at(-1)).toMatchObject({
			name: kind,
			props: kind === "compress" ? { subject: { kind: "drive", items: selectedItems } } : { items: selectedItems }
		})
	})
})

describe("TextViewer — binary guard", () => {
	function renderBinary(name: string, onTextState?: (state: { writable: boolean; encoding: string }) => void) {
		previewBytes.current = Uint8Array.of(0x00, 0x00, 0x01, 0x02, 0x03, 0xff, 0x00)

		render(
			<PreviewDownloadableProvider
				downloadable
				onDownload={vi.fn()}
			>
				<TextViewer
					item={named(name)}
					alt={name}
					editable
					{...(onTextState === undefined ? {} : { onTextState })}
				/>
			</PreviewDownloadableProvider>
		)
	}

	// Any text-family open, by its type or through "Open as text".
	it.each(["program.elf", "notes.txt", "module.pl"])("shows %s's binary bytes only behind a notice with Download", name => {
		renderBinary(name)

		expect(screen.getByText("This file isn't text.")).toBeDefined()
		expect(screen.getByRole("button", { name: /download/i })).toBeDefined()
		expect(screen.getByRole("button", { name: "Show anyway (read-only)" })).toBeDefined()
		expect(screen.queryByTestId("source")).toBeNull()
	})

	it("shows the bytes anyway on request, read-only, and tells the overlay", () => {
		const onTextState = vi.fn()

		renderBinary("notes.txt", onTextState)
		expect(onTextState).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Show anyway (read-only)" }))

		expect(screen.getByTestId("source").dataset["editable"]).toBe("false")
		expect(onTextState).toHaveBeenLastCalledWith(expect.objectContaining({ writable: false }))
	})

	it("shows a text file", () => {
		previewBytes.current = new TextEncoder().encode("key = value")

		render(
			<TextViewer
				item={named("settings.bin")}
				alt="settings.bin"
			/>
		)

		expect(screen.getByTestId("source").textContent).toBe("key = value")
	})

	it("shows UTF-16 text, whose zero bytes are not a binary sign", () => {
		previewBytes.current = Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00)

		render(
			<TextViewer
				item={named("notes.bin")}
				alt="notes.bin"
			/>
		)

		expect(screen.getByTestId("source").textContent).toBe("hi")
	})
})

describe("MarkdownViewer — binary guard", () => {
	registerAllActions()

	it("shows binary bytes only on request, read-only, and tells the overlay", () => {
		previewBytes.current = Uint8Array.of(0x23, 0x20, 0x00, 0x01)
		const onTextState = vi.fn()

		render(
			<MarkdownViewer
				item={named("notes.md")}
				alt="notes.md"
				editable
				onTextState={onTextState}
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.getByText("This file isn't text.")).toBeDefined()
		expect(onTextState).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Show anyway (read-only)" }))

		expect(screen.queryByText("This file isn't text.")).toBeNull()
		expect(onTextState).toHaveBeenLastCalledWith(expect.objectContaining({ writable: false }))
	})
})

describe("TextViewer — editing only what a save writes back", () => {
	function renderEditable(bytes: Uint8Array<ArrayBuffer>, onTextState: (state: { writable: boolean; encoding: string }) => void) {
		previewBytes.current = bytes

		render(
			<TextViewer
				item={named("notes.txt")}
				alt="notes.txt"
				editable
				onTextState={onTextState}
			/>
		)
	}

	it.each([
		["strict UTF-8", new TextEncoder().encode("café"), "utf-8"],
		["latin-1", Uint8Array.of(0x63, 0x61, 0x66, 0xe9), "windows-1252"],
		["UTF-16", Uint8Array.of(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00), "utf-16le"]
	])("keeps %s editable: a save writes it back in its own encoding", async (_, bytes, encoding) => {
		const onTextState = vi.fn()

		renderEditable(bytes, onTextState)

		expect((await screen.findByTestId("source")).dataset["editable"]).toBe("true")
		// The state is told from an effect, which a render the detector's guess resolved commits after the editor shows.
		await waitFor(() => {
			expect(onTextState).toHaveBeenLastCalledWith({ writable: true, encoding, readEncoding: encoding })
		})
	})

	it.each([
		["UTF-8 with a stray byte", Uint8Array.of(...new TextEncoder().encode("Grüße, Köln, schön"), 0xff), null],
		["Shift JIS, as the detector guesses", Uint8Array.of(0x82, 0xa0, 0x82, 0xa2, 0x93, 0xfa, 0x96, 0x7b), "shift_jis"]
	])("opens %s read-only and tells the overlay", async (_, bytes, guess) => {
		const onTextState = vi.fn()

		detected.current = guess
		renderEditable(bytes, onTextState)

		expect((await screen.findByTestId("source")).dataset["editable"]).toBe("false")
		await waitFor(() => {
			expect(onTextState).toHaveBeenLastCalledWith(expect.objectContaining({ writable: false }))
		})
	})
})
