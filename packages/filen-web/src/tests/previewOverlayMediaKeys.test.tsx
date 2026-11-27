// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewMediaPager } from "@/features/preview/lib/mediaPager"

// The OS's next/previous track keys, as a previewed player hands them to the Media Session: the overlay's pager steps,
// with the header arrows' guards.

const harness = vi.hoisted(() => ({ pager: null as PreviewMediaPager | null }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
// Rename's name check asks the SDK worker, which this test does not run: every name is taken as valid.
vi.mock("@/features/drive/lib/archiveHelpers", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/archiveHelpers")>()),
	cachedItemNameError: () => null,
	itemNameError: () => Promise.resolve(null)
}))
vi.mock("@/features/presentation/components/presentationViewer", async () => {
	const { use } = await vi.importActual<typeof import("react")>("react")
	const { PreviewMediaPagerContext } =
		await vi.importActual<typeof import("@/features/preview/lib/mediaPager")>("@/features/preview/lib/mediaPager")

	return {
		PresentationViewer: () => {
			harness.pager = use(PreviewMediaPagerContext)

			return null
		}
	}
})

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { setPreviewDirty, usePreviewUnsavedGuardStore } from "@/features/preview/store/usePreviewUnsavedGuard"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

registerAllActions()

function deck(uuid: File["uuid"]): DriveItem {
	return narrowItem({
		uuid,
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

const ITEMS = [deck("11111111-1111-1111-1111-000000000001"), deck("11111111-1111-1111-1111-000000000002")]

afterEach(() => {
	cleanup()
	harness.pager = null
	usePreviewUnsavedGuardStore.setState({ dirty: false, logoutRequest: null })
})

function shown(index: number): ReturnType<typeof vi.fn> {
	const onStep = vi.fn()

	render(
		createElement(PreviewOverlay, {
			variant: "drive" as const,
			items: ITEMS,
			index,
			onStep,
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		}),
		// Rename checks the name against the held listing through a query.
		{ wrapper: queryClientWrapper(createTestQueryClient()) }
	)

	return onStep
}

async function pager(): Promise<PreviewMediaPager> {
	await screen.findByRole("button", { name: "Next file" })

	if (harness.pager === null) throw new Error("no viewer")

	return harness.pager
}

describe("PreviewOverlay — media keys", () => {
	it("steps the pager, offering only the directions it can go", async () => {
		const onStep = shown(0)
		const keys = await pager()

		expect(keys.previous).toBeNull()

		act(() => {
			keys.next?.()
		})
		expect(onStep).toHaveBeenCalledWith(1)
	})

	it("asks about unsaved changes first, as the arrows do", async () => {
		const onStep = shown(1)
		const keys = await pager()

		expect(keys.next).toBeNull()

		act(() => {
			setPreviewDirty(true)
		})
		act(() => {
			harness.pager?.previous?.()
		})

		expect(onStep).not.toHaveBeenCalled()
		expect(await screen.findByRole("alertdialog")).toBeTruthy()
	})

	it("is held off while a dialog is open", async () => {
		shown(0)
		await pager()

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: /^Rename/ }))
		await screen.findByRole("dialog", { name: "Rename" })

		expect(harness.pager?.next).toBeNull()
		expect(harness.pager?.previous).toBeNull()
	})
})
