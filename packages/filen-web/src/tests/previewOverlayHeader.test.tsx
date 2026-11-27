// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"

// The header's favorite star (shown where the menu offers Favorite, toggling in place and following a toggle made
// elsewhere) and its position among the paged files.

const harness = vi.hoisted(() => ({ toggled: [] as string[] }))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/presentation/components/presentationViewer", () => ({ PresentationViewer: () => null }))
vi.mock("@/features/drive/lib/favorite", async () => {
	const { withFavorited } = await vi.importActual<typeof import("@/features/drive/lib/item")>("@/features/drive/lib/item")

	return {
		toggleItemFavorite: (item: DriveItem, _variant: unknown, onToggled: ((item: DriveItem) => void) | undefined) => {
			harness.toggled.push(item.data.uuid)
			onToggled?.(withFavorited(item, !item.data.favorited))

			return Promise.resolve()
		}
	}
})

import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { emitPreviewFavoriteChanged } from "@/features/preview/lib/previewReconcile"

registerAllActions()

const UUID: File["uuid"] = "11111111-1111-1111-1111-111111111111"

function deck(uuid: File["uuid"] = UUID): DriveItem {
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

afterEach(() => {
	cleanup()
	harness.toggled = []
})

function shown(variant: "drive" | "sharedIn", items: DriveItem[] = [deck()], index = 0): void {
	render(
		createElement(PreviewOverlay, {
			variant,
			items,
			index,
			onStep: vi.fn(),
			onClose: vi.fn(),
			onItemRemoved: vi.fn()
		})
	)
}

describe("PreviewOverlay — favorite star", () => {
	it("toggles the open item and shows its new state at once", async () => {
		shown("drive")

		const star = await screen.findByRole("button", { name: "Favorite" })

		expect(star.getAttribute("aria-pressed")).toBe("false")

		await act(async () => {
			fireEvent.click(star)
			await Promise.resolve()
		})

		expect(harness.toggled).toEqual([UUID])
		expect(screen.getByRole("button", { name: "Unfavorite" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("follows a favorite changed elsewhere", async () => {
		shown("drive")
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "Favorite" }))
			await Promise.resolve()
		})

		act(() => {
			emitPreviewFavoriteChanged(UUID, false)
		})

		expect(screen.getByRole("button", { name: "Favorite" }).getAttribute("aria-pressed")).toBe("false")
	})

	it("shows the open file's place among the paged files, and nothing for a single file", async () => {
		const items = Array.from({ length: 812 }, (_, at) => deck(`11111111-1111-1111-1111-${String(at).padStart(12, "0")}`))

		shown("drive", items, 36)
		expect(await screen.findByText("37 / 812")).toBeTruthy()

		cleanup()
		shown("drive")
		await screen.findByRole("button", { name: "Favorite" })
		expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull()
	})

	it("is not offered where the menu offers no Favorite", async () => {
		shown("sharedIn")
		await screen.findByRole("button", { name: "More actions" })

		expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull()
	})
})
