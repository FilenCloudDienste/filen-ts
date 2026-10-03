// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClientProvider } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import "@/lib/i18n"

// Browse contents in an archive's item menu is the surface's own Open, which opens the archive browser
// in the preview overlay; a surface without an Open (the overlay's own header menu) has no Browse.

const { sdk } = vi.hoisted(() => ({
	sdk: { archiveNameInfo: vi.fn<(names: string[]) => Promise<ArchiveNameInfo[]>>() }
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/features/drive/lib/archiveActions", () => ({ compressWithPreset: vi.fn(), extractQuick: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { queryClient } from "@/queries/client"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { testUuid } from "@/tests/support/uuid"

function archive(name: string): DriveItem {
	return narrowItem({
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/zip", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function renderMenu(item: DriveItem, onOpen: (() => void) | undefined): void {
	render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(
				DropdownMenu,
				{ defaultOpen: true },
				createElement(DropdownMenuTrigger, null, "menu"),
				createElement(DriveDropdownMenuContent, { item, variant: "drive", onItemAction: vi.fn(), onOpen })
			)
		)
	)
}

// Base UI opens a submenu on ArrowRight — the keyboard path, free of hover timers.
async function openExtract(): Promise<void> {
	const trigger = screen.getByRole("menuitem", { name: "Extract" })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowRight" })

		for (let i = 0; i < 5; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	queryClient.clear()
	sdk.archiveNameInfo.mockImplementation(names =>
		Promise.resolve(names.map(name => ({ format: { type: "zip" }, defaultName: name.replace(/\.zip$/, "") })))
	)
})

afterEach(() => {
	cleanup()
})

describe("item menu Browse contents", () => {
	it("opens the archive the way Open does", async () => {
		const onOpen = vi.fn()

		renderMenu(archive("photos.zip"), onOpen)

		expect(screen.getAllByRole("menuitem")[0]?.textContent).toContain("Open")

		await openExtract()

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Browse contents" }))
		})

		expect(onOpen).toHaveBeenCalledOnce()
	})

	it("is absent where the surface cannot open the archive", async () => {
		renderMenu(archive("photos.zip"), undefined)

		await openExtract()

		expect(screen.getByRole("menuitem", { name: "Extract with options…" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "Browse contents" })).toBeNull()
	})
})
