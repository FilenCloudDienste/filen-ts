// @vitest-environment jsdom

// The preview header menu's trash, delete and unshare keep the confirm's own spinner while they run and
// then toast only their result, in the words of the same action anywhere else.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, UuidStr } from "@filen/sdk-rs"

const { trashItems, toast } = vi.hoisted(() => ({
	trashItems: vi.fn(),
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() })
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/drive"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn(), IN_EDITORS: {}, IN_EDITORS_AND_FIELDS: {} }))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/preview/components/pdfViewer", () => ({ PdfViewer: () => null }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	trashItems
}))

import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"

const REPORT = narrowItem({
	uuid: "report-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

async function trashFromMenu(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "More actions" }))
	fireEvent.click(await screen.findByRole("menuitem", { name: "Trash" }))
	fireEvent.click(await screen.findByRole("button", { name: "Trash" }))
}

describe("PreviewOverlay header menu trash", () => {
	it("toasts only the result, then steps past the trashed file", async () => {
		let finish: (outcome: unknown) => void = () => undefined
		trashItems.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		const onItemRemoved = vi.fn()
		render(
			createElement(PreviewOverlay, { variant: "drive", items: [REPORT], index: 0, onStep: vi.fn(), onClose: vi.fn(), onItemRemoved })
		)

		await trashFromMenu()

		expect(trashItems).toHaveBeenCalledExactlyOnceWith([REPORT], expect.any(Function), expect.any(Function))
		expect(toast).not.toHaveBeenCalled()

		await act(async () => {
			finish({ succeeded: [REPORT], failed: [] })
			await Promise.resolve()
		})

		expect(toast.success).toHaveBeenCalledExactlyOnceWith("Moved report.pdf to trash", expect.anything())
		expect(onItemRemoved).toHaveBeenCalledExactlyOnceWith(REPORT.data.uuid)
	})

	it("keeps the file on a failed trash, saying why", async () => {
		trashItems.mockResolvedValueOnce({
			succeeded: [],
			failed: [{ item: REPORT, error: { species: "plain", message: "Not allowed", label: "Not allowed" } }]
		})
		const onItemRemoved = vi.fn()
		render(
			createElement(PreviewOverlay, { variant: "drive", items: [REPORT], index: 0, onStep: vi.fn(), onClose: vi.fn(), onItemRemoved })
		)

		await trashFromMenu()
		await act(async () => {
			await Promise.resolve()
		})

		expect(toast.error).toHaveBeenCalledExactlyOnceWith(
			"Couldn't move report.pdf to trash",
			expect.objectContaining({ description: "Not allowed" })
		)
		expect(onItemRemoved).not.toHaveBeenCalled()
	})
})
