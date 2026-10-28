// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { File as SdkFile } from "@filen/sdk-rs"
import { ZipArchive, bytesSource } from "@filen/office/core/opc"

const { uploadFileBytes, nameTakenInDirectory, driveListingQueryUpdate, cachedListing, isDriveListingCurrent, toastInfo } = vi.hoisted(
	() => ({
		uploadFileBytes: vi.fn<(parent: string | null, data: Uint8Array, name: string, mime: string) => Promise<SdkFile>>(),
		nameTakenInDirectory: vi.fn<(parent: string | null, name: string) => Promise<boolean>>(() => Promise.resolve(false)),
		driveListingQueryUpdate: vi.fn(),
		cachedListing: vi.fn<(variant: string, uuid: string | null) => unknown[] | undefined>(() => undefined),
		isDriveListingCurrent: vi.fn<(uuid: string | null) => boolean>(() => false),
		toastInfo: vi.fn()
	})
)

// The New menu's New directory shortcut; registering it needs the drive keymap, which this file never loads.
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { uploadFileBytes } }))
vi.mock("@/features/drive/lib/nameTaken", () => ({ nameTakenInDirectory }))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	driveListingQueryUpdate,
	cachedListing,
	isDriveListingCurrent
}))
vi.mock("sonner", async importOriginal => {
	const actual = await importOriginal<typeof import("sonner")>()

	return { ...actual, toast: Object.assign(vi.fn(), actual.toast, { info: toastInfo }) }
})
vi.mock("@/lib/keymap/kbd", async () => {
	const { createElement: element } = await import("react")
	return { Kbd: ({ action }: { action: string }) => element("span", null, ` ${action}`) }
})

import "@/lib/i18n"
import { NewMenu } from "@/features/drive/components/uploadMenu"
import { DestinationEntries } from "@/features/drive/components/destinationMenu"
import { DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { narrowItem } from "@/features/drive/lib/item"

const TAKEN = "A file or directory with this name already exists here."
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const ODT_MIME = "application/vnd.oasis.opendocument.text"
const ODS_MIME = "application/vnd.oasis.opendocument.spreadsheet"

beforeEach(() => {
	nameTakenInDirectory.mockResolvedValue(false)
	cachedListing.mockReturnValue(undefined)
	isDriveListingCurrent.mockReturnValue(false)
})

afterEach(() => {
	cleanup()
})

function created(name: string): SdkFile {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		chunks: 1n,
		size: 2048n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1_700_000_000_000n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: DOCX_MIME, size: 2048n, modified: 0n, key: "k", version: 2 } }
	}
}

function renderMenu(options: { offline?: boolean; hiddenNotice?: boolean } = {}) {
	const openPreview = vi.fn()

	render(
		<NewMenu
			parentUuid="parent"
			openPreview={openPreview}
			offline={options.offline ?? false}
			hiddenNotice={options.hiddenNotice ?? false}
		/>
	)

	return { openPreview }
}

async function openOffice(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "New" }))
	await act(async () => {
		fireEvent.click(screen.getByRole("menuitem", { name: "Office" }))
		await Promise.resolve()
	})
}

async function openOpenDocument(): Promise<void> {
	await openOffice()
	await act(async () => {
		fireEvent.click(await screen.findByRole("menuitem", { name: "OpenDocument" }))
		await Promise.resolve()
	})
}

type Entry = "Document (.docx)" | "Spreadsheet (.xlsx)" | "Text (.odt)" | "Spreadsheet (.ods)"

async function choose(entry: Entry): Promise<HTMLInputElement> {
	if (entry.endsWith("(.odt)") || entry.endsWith("(.ods)")) await openOpenDocument()
	else await openOffice()
	fireEvent.click(await screen.findByRole("menuitem", { name: entry }))

	const field = await screen.findByLabelText("Name")

	if (!(field instanceof HTMLInputElement)) throw new Error("no name field")

	return field
}

function submit(field: HTMLInputElement, name?: string): void {
	if (name !== undefined) fireEvent.change(field, { target: { value: name } })
	fireEvent.click(screen.getByRole("button", { name: "Create" }))
}

async function part(bytes: Uint8Array, name: string): Promise<string> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const entry = zip.get(name)

	if (entry === undefined) throw new Error(`No part ${name}`)

	return new TextDecoder().decode(await zip.read(entry))
}

describe("New ▸ Office", () => {
	it("offers a Document and a Spreadsheet in the Office submenu", async () => {
		renderMenu()
		await openOffice()

		expect((await screen.findByRole("menuitem", { name: "Document (.docx)" })).textContent).toBe("Document (.docx)")
		expect(screen.getByRole("menuitem", { name: "Spreadsheet (.xlsx)" }).textContent).toBe("Spreadsheet (.xlsx)")
	})

	it("offers OpenDocument ▸ Text and Spreadsheet after the Office Open XML entries, a rule between", async () => {
		renderMenu()
		await openOffice()

		const office = (await screen.findByRole("menuitem", { name: "Document (.docx)" })).closest("[role=menu]")

		expect(
			[...(office?.querySelectorAll("[role=menuitem], [role=separator]") ?? [])].map(entry =>
				entry.getAttribute("role") === "separator" ? "─" : entry.textContent
			)
		).toEqual(["Document (.docx)", "Spreadsheet (.xlsx)", "─", "OpenDocument"])

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "OpenDocument" }))
			await Promise.resolve()
		})

		expect((await screen.findByRole("menuitem", { name: "Text (.odt)" })).textContent).toBe("Text (.odt)")
		expect(screen.getByRole("menuitem", { name: "Spreadsheet (.ods)" }).textContent).toBe("Spreadsheet (.ods)")
	})

	it("is disabled offline where the menu stays open offline", () => {
		render(
			<DropdownMenu defaultOpen>
				<DropdownMenuTrigger>menu</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DestinationEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						actions={{ newTextFile: vi.fn(), newOffice: vi.fn(), pickFiles: vi.fn(), pickDirectory: vi.fn() }}
						offline
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		)

		const trigger = screen.getByRole("menuitem", { name: "Office" })

		expect(trigger.hasAttribute("data-disabled")).toBe(true)
		expect(trigger.getAttribute("title")).toBe("Unavailable while offline")
	})

	it("starts on a localized untitled name with only its base name selected", async () => {
		renderMenu()

		const field = await choose("Document (.docx)")

		expect(screen.getByRole("heading", { name: "New document" })).toBeTruthy()
		expect(field.value).toBe("Untitled document.docx")
		fireEvent.focus(field)
		expect([field.selectionStart, field.selectionEnd]).toEqual([0, "Untitled document".length])
	})

	it("starts on a free name when the listing on screen already holds the untitled one", async () => {
		isDriveListingCurrent.mockReturnValue(true)
		cachedListing.mockReturnValue([narrowItem(created("untitled SPREADSHEET.xlsx"))])
		renderMenu()

		expect((await choose("Spreadsheet (.xlsx)")).value).toBe("Untitled spreadsheet (2).xlsx")
	})

	it("refuses a taken name inline and never uploads onto it", async () => {
		nameTakenInDirectory.mockResolvedValue(true)
		const { openPreview } = renderMenu()
		const field = await choose("Document (.docx)")

		submit(field, "Report")

		expect(await screen.findByText(TAKEN)).toBeTruthy()
		expect(nameTakenInDirectory).toHaveBeenCalledWith("parent", "Report.docx")
		expect(uploadFileBytes).not.toHaveBeenCalled()
		expect(openPreview).not.toHaveBeenCalled()

		fireEvent.change(field, { target: { value: "Report 2" } })
		expect(screen.queryByText(TAKEN)).toBeNull()
	})

	it("uploads a blank document, patches the listing and opens the editor at once", async () => {
		uploadFileBytes.mockResolvedValue(created("Report.docx"))
		const { openPreview } = renderMenu()

		submit(await choose("Document (.docx)"), "Report")

		await waitFor(() => {
			expect(openPreview).toHaveBeenCalledOnce()
		})

		const [parent, bytes, name, mime] = uploadFileBytes.mock.calls[0] ?? []

		expect([parent, name, mime]).toEqual(["parent", "Report.docx", DOCX_MIME])
		expect(await part(bytes ?? new Uint8Array(), "word/styles.xml")).toContain('<w:rFonts w:ascii="Calibri"')
		expect(driveListingQueryUpdate).toHaveBeenCalledWith("parent", expect.any(Function))
		expect(openPreview.mock.calls[0]?.[0]).toEqual([narrowItem(created("Report.docx"))])
		await waitFor(() => {
			expect(screen.queryByLabelText("Name")).toBeNull()
		})
	})

	it("names a new workbook's sheet in the user's language and uploads it as a workbook", async () => {
		uploadFileBytes.mockResolvedValue(created("Budget.xlsx"))
		const { openPreview } = renderMenu()

		submit(await choose("Spreadsheet (.xlsx)"), "Budget.xlsx")

		await waitFor(() => {
			expect(openPreview).toHaveBeenCalledOnce()
		})

		const [, bytes, name, mime] = uploadFileBytes.mock.calls[0] ?? []

		expect([name, mime]).toEqual(["Budget.xlsx", XLSX_MIME])
		expect(await part(bytes ?? new Uint8Array(), "xl/workbook.xml")).toContain('<sheet name="Sheet1"')
	})

	it("uploads a blank OpenDocument text document under its type and opens it", async () => {
		uploadFileBytes.mockResolvedValue(created("Letter.odt"))
		const { openPreview } = renderMenu()
		const field = await choose("Text (.odt)")

		expect(screen.getByRole("heading", { name: "New document" })).toBeTruthy()
		expect(field.value).toBe("Untitled document.odt")
		submit(field, "Letter")

		await waitFor(() => {
			expect(openPreview).toHaveBeenCalledOnce()
		})

		const [parent, bytes, name, mime] = uploadFileBytes.mock.calls[0] ?? []

		expect([parent, name, mime]).toEqual(["parent", "Letter.odt", ODT_MIME])
		expect(await part(bytes ?? new Uint8Array(), "styles.xml")).toContain('style:font-name="Calibri" fo:font-size="11pt"')
	})

	it("uploads a blank OpenDocument spreadsheet with its sheet in the user's language", async () => {
		uploadFileBytes.mockResolvedValue(created("Budget.ods"))
		const { openPreview } = renderMenu()
		const field = await choose("Spreadsheet (.ods)")

		expect(screen.getByRole("heading", { name: "New spreadsheet" })).toBeTruthy()
		submit(field, "Budget")

		await waitFor(() => {
			expect(openPreview).toHaveBeenCalledOnce()
		})

		const [, bytes, name, mime] = uploadFileBytes.mock.calls[0] ?? []

		expect([name, mime]).toEqual(["Budget.ods", ODS_MIME])
		expect(await part(bytes ?? new Uint8Array(), "content.xml")).toContain('table:name="Sheet1"')
	})

	it("says when the new file's name hides it from the listing", async () => {
		uploadFileBytes.mockResolvedValue(created(".plan.docx"))
		const { openPreview } = renderMenu({ hiddenNotice: true })

		submit(await choose("Document (.docx)"), ".plan")

		await waitFor(() => {
			expect(openPreview).toHaveBeenCalledOnce()
		})
		expect(toastInfo).toHaveBeenCalledOnce()
	})
})
