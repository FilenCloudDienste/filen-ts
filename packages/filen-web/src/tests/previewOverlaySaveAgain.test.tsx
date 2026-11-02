// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"

// A save asked for while a deck save is in flight (a second Mod+S, an autosave meeting one) is not dropped: it runs
// once the first settles, when the deck is still dirty then; a deck the first save left clean saves nothing more.

const harness = vi.hoisted(() => ({
	saves: 0,
	dirtyAfter: true,
	edited: false,
	finishUpload: [] as (() => void)[],
	actions: new Map<string, (event: KeyboardEvent) => void>(),
	setDirty: (_dirty: boolean): void => undefined,
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: harness.toasts }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({
	useAction: (id: string, handler: (event: KeyboardEvent) => void) => {
		harness.actions.set(id, handler)

		return () => undefined
	},
	IN_EDITORS: {},
	IN_EDITORS_AND_FIELDS: {}
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/lib/previewCache", async () => ({
	...(await vi.importActual<typeof import("@/features/preview/lib/previewCache")>("@/features/preview/lib/previewCache")),
	loadPreviewBytes: () => Promise.resolve()
}))
vi.mock("@/features/drive/lib/previewSave.logic", async () => {
	const actual = await vi.importActual<typeof import("@/features/drive/lib/previewSave.logic")>("@/features/drive/lib/previewSave.logic")

	return {
		...actual,
		// Each upload ends when the test says so, making the file the deck had.
		runPreviewSave: (_deps: unknown, request: { item: unknown }) =>
			new Promise(resolve => {
				harness.finishUpload.push(() => {
					resolve({ status: "success", item: request.item })
				})
			})
	}
})
vi.mock("@/features/presentation/components/presentationViewer", () => ({
	PresentationViewer: ({ editing }: { editing?: { saveRef: { current: unknown }; onDirtyChange: (dirty: boolean) => void } }) => {
		useEffect(() => {
			if (editing === undefined) return

			harness.setDirty = editing.onDirtyChange
			editing.saveRef.current = () => {
				harness.saves++

				return Promise.resolve({
					kind: "port",
					port: { close: () => undefined },
					announced: Promise.resolve(true),
					result: Promise.resolve({ kind: "written", revision: harness.saves, bytes: 1, notices: [] }),
					commit: () => {
						// The session tells the page whether edits made during the save leave it dirty.
						editing.onDirtyChange(harness.dirtyAfter)

						return Promise.resolve({ dirty: harness.dirtyAfter })
					}
				})
			}
			// Edited once (the effect runs again on every render the overlay passes a new `editing`).
			if (!harness.edited) {
				harness.edited = true
				editing.onDirtyChange(true)
			}
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
	harness.saves = 0
	harness.dirtyAfter = true
	harness.edited = false
	harness.finishUpload = []
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

async function started(): Promise<void> {
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
		expect(harness.finishUpload).toHaveLength(1)
	})
}

function pressSave(): void {
	const handler = harness.actions.get("preview.save")

	if (handler === undefined) throw new Error("no save action")

	handler(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))
}

describe("PreviewOverlay — a save asked for during a deck save", () => {
	it("runs once the first settles while the deck is still dirty", async () => {
		await started()
		await act(async () => {
			pressSave()
			await Promise.resolve()
		})
		expect(harness.saves).toBe(1)
		await act(async () => {
			harness.finishUpload.shift()?.()
			await Promise.resolve()
		})
		await waitFor(() => {
			expect(harness.saves).toBe(2)
		})
	})

	it("saves nothing more when the first save left the deck clean", async () => {
		harness.dirtyAfter = false
		await started()
		await act(async () => {
			pressSave()
			await Promise.resolve()
		})
		await act(async () => {
			harness.finishUpload.shift()?.()
			await new Promise(resolve => setTimeout(resolve, 20))
		})
		expect(harness.saves).toBe(1)
	})
})
