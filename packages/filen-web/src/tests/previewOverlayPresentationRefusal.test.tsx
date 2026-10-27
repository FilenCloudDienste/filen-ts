// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// A deck save the session refuses after it said it would write: the overlay tells the user why at once and ends the
// upload behind the port, never waiting for an upload that may not settle.

const harness = vi.hoisted(() => ({
	uploads: 0,
	closed: 0,
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
vi.mock("@/features/drive/lib/previewSave.logic", async () => ({
	...(await vi.importActual<typeof import("@/features/drive/lib/previewSave.logic")>("@/features/drive/lib/previewSave.logic")),
	// The upload never settles.
	runPreviewSave: () => {
		harness.uploads++

		return new Promise(() => undefined)
	}
}))
vi.mock("@/features/presentation/components/presentationViewer", () => ({
	PresentationViewer: ({ editing }: { editing?: { saveRef: { current: unknown }; onDirtyChange: (dirty: boolean) => void } }) => {
		useEffect(() => {
			if (editing === undefined) return

			editing.saveRef.current = () =>
				Promise.resolve({
					kind: "port",
					port: {
						close: () => {
							harness.closed++
						}
					},
					announced: Promise.resolve(true),
					result: Promise.resolve({ kind: "refused", reason: "notImplemented" }),
					commit: () => Promise.resolve({ dirty: false })
				})
			editing.onDirtyChange(true)
		}, [editing])

		return null
	}
}))

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

registerAllActions()

function deck() {
	return narrowItem({
		uuid: "11111111-1111-1111-1111-111111111111",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: {
				name: "deck.pptx",
				mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
				modified: 1_700_000_000_000n,
				size: 1_024n,
				key: "key",
				version: 2
			}
		}
	})
}

beforeEach(() => {
	harness.uploads = 0
	harness.closed = 0
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

describe("PreviewOverlay — a deck save the session refuses", () => {
	it("says why at once and ends the upload, without waiting for it", async () => {
		render(
			createElement(PreviewOverlay, {
				variant: "drive" as const,
				items: [deck()],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn()
			})
		)

		const save = await screen.findByRole("button", { name: "Save" })

		await act(async () => {
			fireEvent.click(save)
			await Promise.resolve()
		})
		await waitFor(() => {
			expect(harness.toasts.error).toHaveBeenCalledWith("This presentation has a change that can't be saved in this format yet.")
		})
		expect(harness.uploads).toBe(1)
		expect(harness.closed).toBe(1)
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false)
	})
})

describe("presentation save refusal messages", () => {
	it("names the presentation's own reasons and falls back to the editors' common message", async () => {
		const { presentationSaveRefusalKey } = await vi.importActual<typeof import("@/features/drive/lib/previewSave.logic")>(
			"@/features/drive/lib/previewSave.logic"
		)

		expect(presentationSaveRefusalKey("proofFailed")).toBe("previewPptxSaveRefusedCheck")
		expect(presentationSaveRefusalKey("notImplemented")).toBe("previewPptxSaveRefusedUnsupported")
		expect(presentationSaveRefusalKey("unsupported")).toBe("previewPptxSaveRefusedUnsupported")
		expect(presentationSaveRefusalKey("stale")).toBe("previewPptxSaveRefusedStale")
		expect(presentationSaveRefusalKey("failed")).toBe("previewSaveFailed")
		expect(presentationSaveRefusalKey("tooLarge")).toBe("previewSaveFailed")
	})
})
