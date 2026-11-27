// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const DIRECTORY = narrowItem({
	uuid: "11111111-1111-1111-1111-111111111111" as UuidStr,
	parent: "22222222-2222-2222-2222-222222222222" as UuidStr,
	color: "default",
	timestamp: 0n,
	favorited: false,
	meta: { type: "decoded", data: { name: "Documents" } }
} satisfies Dir)

const FILE = narrowItem({
	uuid: "33333333-3333-3333-3333-333333333333" as UuidStr,
	stableUUID: undefined,
	parent: "22222222-2222-2222-2222-222222222222" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.txt", mime: "text/plain", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File)

const writeText = vi.fn((_text: string) => Promise.resolve())

function renderMenu(item: DriveItem, variant: DriveVariant) {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(DriveDropdownMenuContent, { items: [item], variant, onDialogAction: vi.fn() })
		)
	)
}

beforeEach(() => {
	writeText.mockImplementation(() => Promise.resolve())
	Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
})

afterEach(() => {
	cleanup()
})

describe("item menu Copy ID", () => {
	it.each([
		["a directory", DIRECTORY, "drive"],
		["a file", FILE, "drive"],
		["a trashed file", FILE, "trash"]
	] as const)("copies the uuid of %s and says so", async (_label, item, variant) => {
		renderMenu(item, variant)

		fireEvent.click(screen.getByRole("menuitem", { name: "Copy ID" }))

		expect(writeText).toHaveBeenCalledExactlyOnceWith(item.data.uuid)
		await vi.waitFor(() => {
			expect(toastSuccess).toHaveBeenCalledExactlyOnceWith("ID copied to clipboard")
		})
	})

	it("sits right after Info", () => {
		renderMenu(FILE, "drive")

		const labels = screen.getAllByRole("menuitem").map(entry => entry.textContent)

		expect(labels.indexOf("Copy ID")).toBe(labels.indexOf("Info") + 1)
	})

	it("says why when the clipboard refuses the write", async () => {
		writeText.mockImplementation(() => Promise.reject(new Error("denied")))
		renderMenu(FILE, "drive")

		fireEvent.click(screen.getByRole("menuitem", { name: "Copy ID" }))

		await vi.waitFor(() => {
			expect(toastError).toHaveBeenCalledOnce()
		})
		expect(toastSuccess).not.toHaveBeenCalled()
	})
})
