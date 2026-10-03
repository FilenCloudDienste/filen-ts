// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { File } from "@filen/sdk-rs"
import type { ArchiveFormatInfo, ArchiveNameInfo } from "@/workers/sdk.worker"
import "@/lib/i18n"

// The submenus against the real name-info helper, with the worker's archive calls counted: Compress must
// never reach the worker before a click, Extract asks once per archive name and never again on re-open.

const { sdk, compressWithPreset, extractQuick } = vi.hoisted(() => ({
	sdk: {
		archiveNameInfo: vi.fn<(names: string[]) => Promise<ArchiveNameInfo[]>>(),
		archiveFormatInfo: vi.fn<() => Promise<ArchiveFormatInfo[]>>(),
		archiveCodecMemBudget: vi.fn<() => Promise<number>>()
	},
	compressWithPreset: vi.fn(),
	extractQuick: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/lib/archiveActions", () => ({ compressWithPreset, extractQuick }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDirectoryTreeChildrenQuery: () => ({ status: "success", data: [] })
}))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { queryClient } from "@/queries/client"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { BulkExtractSubmenu, CompressSubmenu, ExtractSubmenu } from "@/features/drive/components/archiveSubmenus"
import { BulkActionBar } from "@/features/drive/components/bulkActionBar"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { testUuid } from "@/tests/support/uuid"
import { mockSharedFile } from "@/tests/fixtures/sdk"

function archive(name: string, label = name): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

function inOpenMenu(children: ReactNode) {
	return render(
		createElement(
			QueryClientProvider,
			{ client: queryClient },
			createElement(
				DropdownMenu,
				{ defaultOpen: true },
				createElement(DropdownMenuTrigger, null, "menu"),
				createElement(DropdownMenuContent, null, children)
			)
		)
	)
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 5; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

// Base UI opens a submenu on ArrowRight and closes it on ArrowLeft — the keyboard path, free of hover timers.
async function openSubmenu(name: string): Promise<void> {
	const trigger = screen.getByRole("menuitem", { name })

	await act(async () => {
		trigger.focus()
		fireEvent.keyDown(trigger, { key: "ArrowRight" })
		await Promise.resolve()
	})
}

async function closeSubmenuFrom(name: string): Promise<void> {
	const entry = screen.getByRole("menuitem", { name })

	await act(async () => {
		entry.focus()
		fireEvent.keyDown(entry, { key: "ArrowLeft" })
		await Promise.resolve()
	})
}

function entry(name: string): HTMLElement {
	return screen.getByRole("menuitem", { name })
}

function labels(): (string | null)[] {
	return screen.getAllByRole("menuitem").map(item => item.textContent)
}

function isDisabled(element: HTMLElement): boolean {
	return element.getAttribute("aria-disabled") === "true" || element.hasAttribute("data-disabled")
}

function workerCalls(): number {
	return sdk.archiveNameInfo.mock.calls.length + sdk.archiveFormatInfo.mock.calls.length + sdk.archiveCodecMemBudget.mock.calls.length
}

// "x.tar.gz" → a tarball named "x"; "x.gz" → a single compressed file "x".
function answerNames(): void {
	sdk.archiveNameInfo.mockImplementation(names =>
		Promise.resolve(
			names.map(name =>
				name.endsWith(".tar.gz") || name.endsWith(".zip")
					? { format: { type: "zip" }, defaultName: name.replace(/\.(tar\.gz|zip)$/, "") }
					: { format: { type: "single", codec: "gzip" }, defaultName: name.replace(/\.gz$/, "") }
			)
		)
	)
}

function renderExtract(item: DriveItem, variant: DriveVariant = "drive", props: { onBrowse?: () => void; disabled?: boolean } = {}) {
	const onChooseDestination = vi.fn()
	const onOptions = vi.fn()

	inOpenMenu(
		createElement(ExtractSubmenu, {
			family: DROPDOWN_TREE_MENU_FAMILY,
			disabled: props.disabled ?? false,
			item,
			variant,
			onChooseDestination,
			onOptions,
			onBrowse: props.onBrowse
		})
	)

	return { onChooseDestination, onOptions }
}

beforeEach(() => {
	vi.clearAllMocks()
	queryClient.clear()
	answerNames()
})

afterEach(() => {
	cleanup()
	onlineManager.setOnline(true)
})

describe("CompressSubmenu", () => {
	function renderCompress(items: DriveItem[], disabled = false) {
		const onMoreOptions = vi.fn()

		inOpenMenu(createElement(CompressSubmenu, { family: DROPDOWN_TREE_MENU_FAMILY, disabled, items, variant: "drive", onMoreOptions }))

		return { onMoreOptions }
	}

	it("offers the three presets and More options without a single worker call", async () => {
		renderCompress([archive("a.pdf")])

		await openSubmenu("Compress")
		await settle()

		expect(labels()).toEqual(["Compress", "ZIP (.zip)", "7-Zip (.7z)", "Tarball (.tar.gz)", "More options…"])
		expect(workerCalls()).toBe(0)
		expect(compressWithPreset).not.toHaveBeenCalled()
	})

	it("starts a preset on its click", async () => {
		const items = [archive("a.pdf"), archive("b.pdf")]

		renderCompress(items)
		await openSubmenu("Compress")

		act(() => {
			fireEvent.click(entry("7-Zip (.7z)"))
		})

		expect(compressWithPreset).toHaveBeenCalledExactlyOnceWith(items, "drive", "7z", undefined)
	})

	it("opens the options dialog from More options", async () => {
		const { onMoreOptions } = renderCompress([archive("a.pdf")])

		await openSubmenu("Compress")

		act(() => {
			fireEvent.click(entry("More options…"))
		})

		expect(onMoreOptions).toHaveBeenCalledOnce()
		expect(compressWithPreset).not.toHaveBeenCalled()
	})

	it("greys out its trigger when disabled (offline)", () => {
		renderCompress([archive("a.pdf")], true)

		expect(isDisabled(entry("Compress"))).toBe(true)
	})

	it("greys out the presets but not More options when the connection drops while open", async () => {
		renderCompress([archive("a.pdf")])
		await openSubmenu("Compress")

		act(() => {
			onlineManager.setOnline(false)
		})

		expect(isDisabled(entry("ZIP (.zip)"))).toBe(true)
		expect(isDisabled(entry("Tarball (.tar.gz)"))).toBe(true)
		expect(isDisabled(entry("More options…"))).toBe(false)

		act(() => {
			fireEvent.click(entry("7-Zip (.7z)"))
		})

		expect(compressWithPreset).not.toHaveBeenCalled()
	})
})

describe("ExtractSubmenu", () => {
	it("asks the worker once for the name, and not again when opened a second time", async () => {
		renderExtract(archive("photos.zip"))

		await openSubmenu("Extract")
		await settle()

		expect(sdk.archiveNameInfo).toHaveBeenCalledExactlyOnceWith(["photos.zip"])
		expect(labels()).toEqual([
			"Extract",
			"Extract here to “photos/”",
			"Extract here",
			"Extract to",
			"Choose destination…",
			"Extract with options…"
		])

		await closeSubmenuFrom("Extract here")
		expect(screen.queryByRole("menuitem", { name: "Extract here" })).toBeNull()

		await openSubmenu("Extract")
		await settle()

		expect(entry("Extract here to “photos/”")).toBeDefined()
		expect(sdk.archiveNameInfo).toHaveBeenCalledOnce()
	})

	it("keeps the here entries disabled until the name is answered", async () => {
		let answer: (infos: ArchiveNameInfo[]) => void = () => undefined

		sdk.archiveNameInfo.mockImplementation(
			() =>
				new Promise(resolve => {
					answer = resolve
				})
		)
		renderExtract(archive("slow.zip"))

		await openSubmenu("Extract")
		await settle()

		expect(isDisabled(entry("Extract here"))).toBe(true)

		await act(async () => {
			answer([{ format: { type: "zip" }, defaultName: "slow" }])
			await Promise.resolve()
		})
		await settle()

		expect(isDisabled(entry("Extract here"))).toBe(false)
		expect(isDisabled(entry("Extract here to “slow/”"))).toBe(false)
	})

	it.each([
		["Extract here to “photos/”", { type: "hereNewFolder" }],
		["Extract here", { type: "here" }]
	])("runs %s as a quick extract", async (label, how) => {
		const item = archive("photos.zip")

		renderExtract(item)
		await openSubmenu("Extract")
		await settle()

		act(() => {
			fireEvent.click(entry(label))
		})

		expect(extractQuick).toHaveBeenCalledExactlyOnceWith([item], "drive", how)
	})

	it("hands the destination picker and the options dialog to the host", async () => {
		const { onChooseDestination, onOptions } = renderExtract(archive("photos.zip"))

		await openSubmenu("Extract")
		await settle()

		act(() => {
			fireEvent.click(entry("Choose destination…"))
		})

		expect(onChooseDestination).toHaveBeenCalledOnce()

		cleanup()
		const second = renderExtract(archive("photos.zip"))

		await openSubmenu("Extract")
		await settle()

		act(() => {
			fireEvent.click(entry("Extract with options…"))
		})

		expect(second.onOptions).toHaveBeenCalledOnce()
		expect(onOptions).not.toHaveBeenCalled()
		expect(extractQuick).not.toHaveBeenCalled()
	})

	it("names a single compressed file's result and offers no new directory for it", async () => {
		renderExtract(archive("notes.txt.gz"))

		await openSubmenu("Extract")
		await settle()

		expect(entry("Extract here as “notes.txt”")).toBeDefined()
		expect(labels().some(label => label?.startsWith("Extract here to") === true)).toBe(false)
	})

	it("has no here entries in Shared with me", async () => {
		renderExtract(narrowItem(mockSharedFile()), "sharedIn")

		await openSubmenu("Extract")
		await settle()

		expect(labels()).toEqual(["Extract", "Extract to", "Choose destination…", "Extract with options…"])
	})

	it("offers Browse contents only where the surface can open the browser", async () => {
		const onBrowse = vi.fn()

		renderExtract(archive("photos.zip"), "drive", { onBrowse })

		await openSubmenu("Extract")
		await settle()

		act(() => {
			fireEvent.click(entry("Browse contents"))
		})

		expect(onBrowse).toHaveBeenCalledOnce()
	})

	it("greys out its trigger when disabled (offline), and the network entries when the connection drops while open", async () => {
		renderExtract(archive("photos.zip"), "drive", { disabled: true })

		expect(isDisabled(entry("Extract"))).toBe(true)

		cleanup()
		renderExtract(archive("photos.zip"))
		await openSubmenu("Extract")
		await settle()

		act(() => {
			onlineManager.setOnline(false)
		})

		expect(isDisabled(entry("Extract here"))).toBe(true)
		expect(isDisabled(entry("Choose destination…"))).toBe(true)
		expect(isDisabled(entry("Extract with options…"))).toBe(false)
	})
})

describe("BulkExtractSubmenu", () => {
	function renderBulk(items: DriveItem[], variant: DriveVariant = "drive") {
		const onChooseDestination = vi.fn()

		inOpenMenu(
			createElement(BulkExtractSubmenu, { family: DROPDOWN_TREE_MENU_FAMILY, disabled: false, items, variant, onChooseDestination })
		)

		return { onChooseDestination }
	}

	it("extracts each archive into its own directory, without asking the worker on open", async () => {
		const items = [archive("a.zip"), archive("b.tar.gz")]
		const { onChooseDestination } = renderBulk(items)

		await openSubmenu("Extract")
		await settle()

		expect(labels()).toEqual(["Extract", "Extract here (each into its own directory)", "Extract to", "Choose destination…"])
		expect(workerCalls()).toBe(0)

		act(() => {
			fireEvent.click(entry("Extract here (each into its own directory)"))
		})
		expect(extractQuick).toHaveBeenCalledExactlyOnceWith(items, "drive", { type: "hereNewFolder" })

		cleanup()
		const picker = renderBulk(items)
		await openSubmenu("Extract")

		act(() => {
			fireEvent.click(entry("Choose destination…"))
		})
		expect(picker.onChooseDestination).toHaveBeenCalledOnce()
		expect(onChooseDestination).not.toHaveBeenCalled()
	})

	it("has no here entry in Shared with me", async () => {
		renderBulk([narrowItem(mockSharedFile()), narrowItem(mockSharedFile())], "sharedIn")

		await openSubmenu("Extract")

		expect(labels()).toEqual(["Extract", "Extract to", "Choose destination…"])
	})
})

describe("BulkActionBar — archive menu buttons", () => {
	it("opens the Compress and Extract entries from the selection bar", async () => {
		const items = [archive("a.zip"), archive("b.zip")]

		render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(BulkActionBar, { variant: "drive", selectedItems: items, onDialogAction: vi.fn() })
			)
		)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Compress" }))
			await Promise.resolve()
		})

		expect(entry("Tarball (.tar.gz)")).toBeDefined()

		act(() => {
			fireEvent.click(entry("Tarball (.tar.gz)"))
		})
		expect(compressWithPreset).toHaveBeenCalledExactlyOnceWith(items, "drive", "tar.gz", undefined)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Extract" }))
			await Promise.resolve()
		})

		expect(entry("Extract here (each into its own directory)")).toBeDefined()
		expect(workerCalls()).toBe(0)
	})

	it("offers no Extract button unless every item is an archive", () => {
		render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(BulkActionBar, {
					variant: "drive",
					selectedItems: [archive("a.zip"), archive("b.pdf")],
					onDialogAction: vi.fn()
				})
			)
		)

		expect(screen.getByRole("button", { name: "Compress" })).toBeDefined()
		expect(screen.queryByRole("button", { name: "Extract" })).toBeNull()
	})
})
