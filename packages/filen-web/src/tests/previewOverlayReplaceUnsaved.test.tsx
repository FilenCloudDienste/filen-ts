// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useEffect } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { UuidStr } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"

// A file made to open in the slot of one with unsaved edits (File ▸ New presentation) goes through the overlay's
// unsaved-changes prompt first: Cancel keeps the edited deck on screen and makes nothing, Discard makes and opens it.

const harness = vi.hoisted(() => ({
	shown: [] as string[],
	next: undefined as DriveItem | undefined,
	made: 0,
	replace: undefined as ((make: (open: (item: DriveItem) => void) => void) => void) | undefined
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
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
vi.mock("@/features/presentation/components/presentationViewer", async () => {
	const { usePreviewReplace } = await vi.importActual<typeof import("@/features/preview/lib/previewReplace")>(
		"@/features/preview/lib/previewReplace"
	)

	return {
		PresentationViewer: ({
			item,
			editing
		}: {
			item: { data: { uuid: string } }
			editing?: { onDirtyChange: (dirty: boolean) => void }
		}) => {
			const replace = usePreviewReplace()

			harness.replace = replace

			useEffect(() => {
				harness.shown.push(item.data.uuid)

				if (item.data.uuid === DECK_UUID) editing?.onDirtyChange(true)
			}, [item, editing])

			return null
		}
	}
})

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

registerAllActions()

const DECK_UUID = "11111111-1111-1111-1111-111111111111"
const NEW_UUID = "33333333-3333-3333-3333-333333333333"

function deck(uuid: string, name: string): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
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
				name,
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
	harness.shown = []
	harness.made = 0
	harness.replace = undefined
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

afterEach(() => {
	cleanup()
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

async function mountDirty(): Promise<void> {
	render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: [deck(DECK_UUID, "deck.pptx")],
			index: 0,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)

	await vi.waitFor(() => {
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
	})
}

function replaceWithNew(): void {
	const replace = harness.replace

	if (replace === undefined) throw new Error("no replace in the overlay")

	act(() => {
		replace(open => {
			harness.made++
			open(deck(NEW_UUID, "Untitled presentation.pptx"))
		})
	})
}

describe("PreviewOverlay — a new file in the slot of an edited one", () => {
	it("asks first, and Cancel keeps the edited file on screen with its edits", async () => {
		await mountDirty()
		replaceWithNew()

		const prompt = await screen.findByRole("alertdialog", { name: "Unsaved changes" })

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await vi.waitFor(() => {
			expect(prompt.isConnected).toBe(false)
		})
		expect(harness.made).toBe(0)
		expect(harness.shown).not.toContain(NEW_UUID)
		expect(usePreviewUnsavedGuardStore.getState().dirty).toBe(true)
	})

	it("makes and opens the new file once the edits are discarded", async () => {
		await mountDirty()
		replaceWithNew()
		await screen.findByRole("alertdialog", { name: "Unsaved changes" })
		expect(harness.made).toBe(0)

		fireEvent.click(screen.getByRole("button", { name: "Discard" }))

		await vi.waitFor(() => {
			expect(harness.shown.at(-1)).toBe(NEW_UUID)
		})
	})
})
