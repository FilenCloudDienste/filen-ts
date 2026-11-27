// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { getFileLinkStatus, toastError, toastSuccess } = vi.hoisted(() => ({
	getFileLinkStatus: vi.fn<() => Promise<unknown>>(),
	toastError: vi.fn(),
	toastSuccess: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getFileLinkStatus } }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }))
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
import { queryClient } from "@/queries/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
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

const LINK_UUID = "link-0000-0000-0000-000000000000"
const LINK_STATUS = { linkUuid: LINK_UUID, password: { type: "none" }, expiration: "never", downloadable: true, salt: "salt" }

afterEach(() => {
	cleanup()
	queryClient.clear()
	Reflect.deleteProperty(navigator, "clipboard")
	vi.unstubAllGlobals()
	vi.clearAllMocks()
})

class ClipboardItemStub {
	readonly text: Promise<Blob>

	constructor(data: Record<string, Promise<Blob>>) {
		this.text = data["text/plain"] ?? Promise.reject(new Error("no text/plain"))
	}
}

function stubClipboard() {
	// As a browser does, a failed item promise rejects the write with the browser's own error, not the promise's.
	const write = vi.fn(async (items: ClipboardItemStub[]) => {
		try {
			await items[0]?.text
		} catch {
			throw new Error("NotAllowedError")
		}
	})
	const writeText = vi.fn((_text: string) => Promise.resolve())

	vi.stubGlobal("ClipboardItem", ClipboardItemStub)
	Object.defineProperty(navigator, "clipboard", { value: { write, writeText }, configurable: true })

	return { write, writeText }
}

function renderMenu(onItemAction: () => void) {
	render(
		createElement(
			DropdownMenu,
			{ defaultOpen: true },
			createElement(DropdownMenuTrigger, null, "menu"),
			createElement(DriveDropdownMenuContent, { items: [FILE], variant: "links", onDialogAction: onItemAction })
		)
	)
}

async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => setTimeout(resolve, 0))
	}
}

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
					createElement(DriveDropdownMenuContent, { items: [FILE], variant: "links", onDialogAction: onItemAction })
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

	it("on a cache miss starts the clipboard write within the click, on a promise of the link", async () => {
		const { write, writeText } = stubClipboard()
		let resolveStatus: (status: unknown) => void = () => undefined

		getFileLinkStatus.mockReturnValueOnce(
			new Promise(resolve => {
				resolveStatus = resolve
			})
		)

		const onItemAction = vi.fn()

		renderMenu(onItemAction)
		fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))

		expect(write).toHaveBeenCalledTimes(1)

		const item = write.mock.calls[0]?.[0][0]

		expect(item).toBeInstanceOf(ClipboardItemStub)

		await act(async () => {
			resolveStatus(LINK_STATUS)
			await settle()
		})

		const blob = await item?.text

		expect(blob?.type).toBe("text/plain")
		expect(await blob?.text()).toContain(LINK_UUID)
		expect(writeText).not.toHaveBeenCalled()
		expect(toastSuccess).toHaveBeenCalledTimes(1)
		expect(toastError).not.toHaveBeenCalled()
		expect(onItemAction).not.toHaveBeenCalled()
	})

	it("opens the link dialog without an error toast when the item has no link", async () => {
		stubClipboard()
		getFileLinkStatus.mockResolvedValueOnce(undefined)

		const onItemAction = vi.fn()

		renderMenu(onItemAction)

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))
			await settle()
		})

		expect(onItemAction).toHaveBeenCalledWith("link", [FILE])
		expect(toastError).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("toasts the fetch error, not a clipboard error, when the status read fails on the ClipboardItem path", async () => {
		stubClipboard()
		getFileLinkStatus.mockRejectedValueOnce(new Error("server error"))

		const onItemAction = vi.fn()

		renderMenu(onItemAction)

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))
			await settle()
		})

		expect(toastError).toHaveBeenCalledTimes(1)
		expect(toastError).toHaveBeenCalledWith(errorLabel(new Error("server error")))
		expect(errorLabel(new Error("server error"))).not.toBe(errorLabel(new Error("NotAllowedError")))
		expect(onItemAction).not.toHaveBeenCalled()
		expect(toastSuccess).not.toHaveBeenCalled()
	})

	it("writes a cached link straight away as text, without reading the status again", async () => {
		const { write, writeText } = stubClipboard()

		queryClient.setQueryData(["drive", "linkStatus", FILE.data.uuid], { type: "file", status: LINK_STATUS })

		renderMenu(vi.fn())

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Copy link" }))
			await settle()
		})

		expect(getFileLinkStatus).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
		expect(writeText).toHaveBeenCalledTimes(1)
		expect(writeText.mock.calls[0]?.[0]).toContain(LINK_UUID)
		expect(toastSuccess).toHaveBeenCalledTimes(1)
	})
})
