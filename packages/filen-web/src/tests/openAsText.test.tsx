// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, render, renderHook, screen } from "@testing-library/react"
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
vi.mock("@/features/preview/components/codeMirrorSource", () => ({
	CodeMirrorSource: ({ text }: { text: string }) => createElement("pre", { "data-testid": "source" }, text)
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { TextViewer } from "@/features/preview/components/textViewer"

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
	overlayProps.current = null
	archiveDialogs.length = 0
})

describe("useDriveDialogHost — Open as text", () => {
	it("opens the preview overlay in its text mode on just that file", () => {
		const item = named("settings.cfg")
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", selectedItems: [], hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleItemAction("openAsText", item)
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(overlayProps.current).toMatchObject({ items: [item], index: 0, asText: true })
	})

	it("opens a normal preview without it", () => {
		const item = named("notes.txt")
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", selectedItems: [], hiddenNoticeApplies: false }))

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
		const { result } = renderHook(() => useDriveDialogHost({ variant: "sharedIn", selectedItems: [], hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleItemAction(kind, item)
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
		const { result } = renderHook(() => useDriveDialogHost({ variant: "drive", selectedItems, hiddenNoticeApplies: false }))

		act(() => {
			result.current.handleBulkDialogAction(kind)
		})

		render(<>{result.current.renderActiveDialog()}</>)

		expect(archiveDialogs.at(-1)).toMatchObject({
			name: kind,
			props: kind === "compress" ? { subject: { kind: "drive", items: selectedItems } } : { items: selectedItems }
		})
	})
})

describe("TextViewer — binary guard", () => {
	it("shows a notice instead of a binary file's bytes when opened as text", () => {
		previewBytes.current = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x01)

		render(
			<TextViewer
				item={named("program.elf")}
				alt="program.elf"
				rejectBinary
			/>
		)

		expect(screen.getByText("This file isn't text, so it can't be shown as text.")).toBeDefined()
		expect(screen.queryByTestId("source")).toBeNull()
	})

	it("shows a text file opened as text", () => {
		previewBytes.current = new TextEncoder().encode("key = value")

		render(
			<TextViewer
				item={named("settings.cfg")}
				alt="settings.cfg"
				rejectBinary
			/>
		)

		expect(screen.getByTestId("source").textContent).toBe("key = value")
	})
})
