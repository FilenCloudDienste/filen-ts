// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import { testUuid } from "@/tests/support/uuid"

// The overlay and a text viewer's encoding: a version this open saved in a codepage reads in it (never detected again,
// which could change the codepage under the next save), and a newer version saved elsewhere is compared in the
// codepage the file was read in, even after a conversion.

const harness = vi.hoisted(() => ({
	// Every render of the text viewer: the version it shows and the codepage it was told that version is in.
	viewed: [] as { uuid: string; readAs: string | null | undefined }[],
	state: { writable: true, encoding: "koi8-r", readEncoding: "koi8-r" },
	compared: [] as string[],
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: harness.toasts }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/lib/previewCache", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/previewCache")>("@/features/preview/lib/previewCache")),
	loadPreviewBytes: () => Promise.resolve()
}))
vi.mock("@/features/drive/lib/previewSave.logic", async () => {
	const actual = await vi.importActual<typeof import("@/features/drive/lib/previewSave.logic")>("@/features/drive/lib/previewSave.logic")

	return {
		...actual,
		// A save makes the next version (a new uuid).
		runPreviewSave: () => Promise.resolve({ status: "success", item: version("saved") })
	}
})
vi.mock("@/features/preview/components/remoteCompare", () => ({
	RemoteFileCompare: ({ encoding }: { encoding: string }) => {
		harness.compared.push(encoding)

		return null
	}
}))
vi.mock("@/features/preview/components/textViewer", () => ({
	TextViewer: ({
		item,
		readAs,
		editable,
		onDirtyChange,
		onTextState,
		contentRef
	}: {
		item: { data: { uuid: string } }
		readAs?: string | null
		editable?: boolean
		onDirtyChange?: (dirty: boolean) => void
		onTextState?: (state: typeof harness.state) => void
		contentRef?: { current: unknown }
	}) => {
		harness.viewed.push({ uuid: item.data.uuid, readAs })

		useEffect(() => {
			if (editable !== true || contentRef === undefined) {
				return
			}

			onTextState?.(harness.state)
			contentRef.current = { text: () => "edited", bytes: () => ({ bytes: Uint8Array.of(1) }), explain: () => undefined }
			onDirtyChange?.(true)
		}, [editable, contentRef, onTextState, onDirtyChange])

		return createElement("div", { "data-testid": "text" })
	}
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { emitPreviewFileRevised } from "@/features/preview/lib/previewReconcile"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

function version(label: string) {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: "lineage" as File["stableUUID"],
		parent: testUuid("parent"),
		size: 3n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "notes.txt", mime: "text/plain", modified: 0n, size: 3n, key: "k", version: 2 } }
	})
}

function open(): void {
	render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: [version("opened")],
			index: 0,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)
}

beforeEach(() => {
	harness.viewed = []
	harness.compared = []
	harness.state = { writable: true, encoding: "koi8-r", readEncoding: "koi8-r" }
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — text encodings", () => {
	it("reads the version it saved in the codepage it saved it in, and only that version", async () => {
		open()
		await screen.findByTestId("text")

		fireEvent.click(await screen.findByRole("button", { name: "Save" }))

		await waitFor(() => {
			expect(harness.viewed.at(-1)).toEqual({ uuid: testUuid("saved"), readAs: "koi8-r" })
		})
		expect(harness.viewed.filter(view => view.uuid === testUuid("opened")).every(view => view.readAs === null)).toBe(true)
	})

	it("compares a newer version in the codepage the file was read in, after a conversion too", async () => {
		harness.state = { writable: true, encoding: "utf-8", readEncoding: "windows-1251" }
		open()
		await screen.findByTestId("text")

		act(() => {
			emitPreviewFileRevised({ item: version("theirs") })
		})

		fireEvent.click(await screen.findByRole("button", { name: "Compare" }))

		await waitFor(() => {
			expect(harness.compared.at(-1)).toBe("windows-1251")
		})
	})
})
