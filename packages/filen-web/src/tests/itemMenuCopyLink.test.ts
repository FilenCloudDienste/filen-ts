// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { getFileLinkStatus, toastError } = vi.hoisted(() => ({
	getFileLinkStatus: vi.fn<() => Promise<unknown>>(),
	toastError: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getFileLinkStatus } }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: toastError } }))
vi.mock("@/features/drive/lib/dnd", () => ({ performMove: vi.fn() }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import { narrowItem } from "@/features/drive/lib/item"
import { DriveDropdownMenuContent } from "@/features/drive/components/itemMenu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const FILE = narrowItem({
	uuid: "file-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File)

afterEach(() => {
	cleanup()
})

describe("item menu Copy link", () => {
	it("toasts a failed link-status read instead of leaving an unhandled rejection", async () => {
		getFileLinkStatus.mockRejectedValueOnce(new Error("server error"))
		const onItemAction = vi.fn()
		const unhandled = vi.fn()

		process.on("unhandledRejection", unhandled)

		try {
			render(
				createElement(
					DropdownMenu,
					{ defaultOpen: true },
					createElement(DropdownMenuTrigger, null, "menu"),
					createElement(DriveDropdownMenuContent, { item: FILE, variant: "drive", onItemAction })
				)
			)

			await act(async () => {
				fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))

				for (let i = 0; i < 10; i++) {
					await new Promise(resolve => setTimeout(resolve, 0))
				}
			})

			expect(getFileLinkStatus).toHaveBeenCalledTimes(1)
			expect(toastError).toHaveBeenCalledTimes(1)
			expect(onItemAction).not.toHaveBeenCalled()
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})
})
