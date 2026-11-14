// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import i18n from "i18next"
import { PdfPagesRail, type PdfPagesRailProps } from "@/features/pdf/pages/pagesRail"
import { PdfExtractDialog, type PdfExtractDialogProps } from "@/features/pdf/pages/extractDialog"
import { PdfSplitDialog, type PdfSplitDialogProps } from "@/features/pdf/pages/splitDialog"
import { PdfCropBar } from "@/features/pdf/pages/cropBar"
import { PdfCropOverlay } from "@/features/pdf/pages/cropOverlay"
import { PdfOrganiseGrid } from "@/features/pdf/pages/organiseGrid"
import { previewPdfPages } from "@/locales/en/previewPdf/pages"
import "@/lib/i18n"

// The standalone page-organisation UI: the pages rail and Organise grid (keys, hover actions, live region,
// thumbnails), the Extract and Split dialogs (plans and names), the crop bar's scopes and the crop handles' keys.

i18n.addResourceBundle("en", "preview", previewPdfPages, true, false)

const PAGES = Array.from({ length: 6 }, (_, index) => ({ id: `p${String(index)}`, width: 595, height: 842 }))

function railProps(overrides: Partial<PdfPagesRailProps> = {}): PdfPagesRailProps {
	return {
		pages: PAGES,
		current: 1,
		selected: new Set<number>(),
		onSelect: vi.fn(),
		onSelectionChange: vi.fn(),
		renderThumbnail: vi.fn(() => Promise.resolve({ width: 96, height: 136, close: () => undefined })),
		layout: "rail",
		editable: true,
		onReorder: vi.fn(),
		onRotate: vi.fn(),
		onDelete: vi.fn(),
		...overrides
	}
}

describe("pages rail", () => {
	it("is a listbox of named pages with a roving tab stop", () => {
		render(<PdfPagesRail {...railProps()} />)

		const list = screen.getByRole("listbox", { name: "Pages" })
		const options = within(list).getAllByRole("option")

		expect(options[1]?.getAttribute("aria-label")).toBe("Page 2 of 6")
		expect(options[1]?.getAttribute("tabindex")).toBe("0")
		expect(options[0]?.getAttribute("tabindex")).toBe("-1")
	})

	it("moves with Alt and the arrows, deletes, toggles and selects all", () => {
		const props = railProps({ selected: new Set([1, 2]) })

		render(<PdfPagesRail {...props} />)

		const list = screen.getByRole("listbox", { name: "Pages" })

		fireEvent.keyDown(list, { key: "ArrowDown", altKey: true })
		expect(props.onReorder).toHaveBeenCalledWith([0, 3, 1, 2, 4, 5])
		fireEvent.keyDown(list, { key: "Delete" })
		expect(props.onDelete).toHaveBeenCalledWith([1, 2])
		fireEvent.keyDown(list, { key: " " })
		expect(props.onSelectionChange).toHaveBeenLastCalledWith(new Set([2]))
		fireEvent.keyDown(list, { key: "a", ctrlKey: true })
		expect(props.onSelectionChange).toHaveBeenLastCalledWith(new Set([0, 1, 2, 3, 4, 5]))
	})

	it("takes no page changes when not editable", () => {
		const props = railProps({ editable: false })

		render(<PdfPagesRail {...props} />)
		fireEvent.keyDown(screen.getByRole("listbox", { name: "Pages" }), { key: "Delete" })
		expect(props.onDelete).not.toHaveBeenCalled()
	})

	it("reads the announcement politely and rotates from a page's hover action in the grid", () => {
		const props = railProps({ layout: "grid", announcement: "Page 3 moved to position 2" })
		const { container } = render(<PdfPagesRail {...props} />)

		expect(screen.getByRole("status").textContent).toBe("Page 3 moved to position 2")

		const rotate = container.querySelector<HTMLElement>("[data-fo-index='2'] [data-pdf-page-action='cw']")

		if (rotate === null) throw new Error("no hover action")

		fireEvent.click(rotate)
		expect(props.onRotate).toHaveBeenCalledWith([2], 90)
	})
})

describe("pages rail thumbnails", () => {
	// A 600 px rail: rows of 136 + 12 px, so pages 1–5 in view and page 6 mounted as overscan.
	async function railWith(overrides: Partial<PdfPagesRailProps>): Promise<{ drawn: () => number[]; list: HTMLElement }> {
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
		vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(128)

		const renderThumbnail = vi.fn((_page: number) => Promise.resolve({ width: 96, height: 136, close: () => undefined }))

		render(<PdfPagesRail {...railProps({ ...overrides, renderThumbnail })} />)

		await act(async () => {
			for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))
		})

		return {
			drawn: () => [...new Set(renderThumbnail.mock.calls.map(([page]) => page))].sort((a, b) => a - b),
			list: screen.getByRole("listbox", { name: "Pages" })
		}
	}

	async function settle(): Promise<void> {
		await act(async () => {
			for (let k = 0; k < 20; k++) await new Promise(resolve => setTimeout(resolve, 0))
		})
	}

	it("draws every mounted page, the overscan too, for a document held whole", async () => {
		const rail = await railWith({ current: 0 })

		expect(rail.drawn()).toEqual([0, 1, 2, 3, 4, 5])
		vi.restoreAllMocks()
	})

	it("sparing, draws only the pages next to the one shown until the rail is explored, then the pages in view", async () => {
		const rail = await railWith({ current: 1, sparing: true })

		expect(rail.drawn()).toEqual([0, 1, 2])

		fireEvent.wheel(rail.list)
		await settle()

		// Never the overscan: page 6 is not in view.
		expect(rail.drawn()).toEqual([0, 1, 2, 3, 4])
		vi.restoreAllMocks()
	})
})

describe("organise grid", () => {
	it("runs its toolbar on the selection and refuses deleting every page", () => {
		const onDuplicate = vi.fn()
		const props = railProps({ selected: new Set([0, 1, 2, 3, 4, 5]) })

		render(
			<PdfOrganiseGrid
				{...props}
				insert={{ onBlank: vi.fn(), onFromFilen: vi.fn(), onFromDevice: vi.fn(), onImage: vi.fn() }}
				onDuplicate={onDuplicate}
				onExtract={vi.fn()}
				onSplit={vi.fn()}
				onClose={vi.fn()}
			/>
		)

		const toolbar = screen.getByRole("toolbar", { name: "Page actions" })

		fireEvent.click(within(toolbar).getByRole("button", { name: "Rotate counterclockwise" }))
		expect(props.onRotate).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5], -90)
		fireEvent.click(within(toolbar).getByRole("button", { name: "Duplicate" }))
		expect(onDuplicate).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5])
		expect(within(toolbar).getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(true)
		expect(within(toolbar).getByText("6 pages selected")).toBeTruthy()
	})
})

function copyContext(): Omit<PdfExtractDialogProps, "onExtract" | "onClose"> {
	return {
		name: "report.pdf",
		pageCount: 10,
		selected: [1, 2],
		taken: new Set(["report (pages 2-3).pdf"]),
		encrypted: true,
		ownerAccess: true,
		passwordUnsupported: false,
		signed: true,
		progress: undefined,
		online: true
	}
}

describe("extract dialog", () => {
	it("opens the selection as a new unsaved PDF under a free name, keeping the password", () => {
		const onExtract = vi.fn()

		render(
			<PdfExtractDialog
				{...copyContext()}
				onExtract={onExtract}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getByText("Opens report (pages 2-3 2).pdf, not saved yet")).toBeTruthy()
		expect(screen.getByText("Signatures aren't copied. Where a signature shows on a page, its picture stays.")).toBeTruthy()
		expect(screen.getByText("They're removed from this PDF once the new one is saved.")).toBeTruthy()
		fireEvent.click(screen.getByRole("switch", { name: "Delete pages after extracting" }))
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))
		expect(onExtract).toHaveBeenCalledWith({
			files: [
				{
					ranges: [{ first: 2, last: 3 }],
					name: "report (pages 2-3 2).pdf"
				}
			],
			separate: false,
			deletes: [1, 2],
			protect: true
		})
	})

	it("says Extracting while the new PDF is made, and Saving per file for one file per page", () => {
		const { rerender } = render(
			<PdfExtractDialog
				{...copyContext()}
				progress={{ done: 0, count: 1 }}
				onExtract={vi.fn()}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getByText("Extracting…")).toBeTruthy()
		rerender(
			<PdfExtractDialog
				{...copyContext()}
				onExtract={vi.fn()}
				onClose={vi.fn()}
			/>
		)
		fireEvent.click(screen.getByRole("switch", { name: "One file per page" }))
		expect(screen.getByText("Each page is saved straight away as a PDF of its own.")).toBeTruthy()
		rerender(
			<PdfExtractDialog
				{...copyContext()}
				progress={{ done: 1, count: 2 }}
				onExtract={vi.fn()}
				onClose={vi.fn()}
			/>
		)
		expect(screen.getByText("Saving 1 of 2…")).toBeTruthy()
	})

	it("makes one file per typed page and blocks a password it cannot carry", () => {
		render(
			<PdfExtractDialog
				{...copyContext()}
				passwordUnsupported
				onExtract={vi.fn()}
				onClose={vi.fn()}
			/>
		)

		fireEvent.change(screen.getByRole("textbox", { name: "Pages to extract" }), { target: { value: "4-5" } })
		fireEvent.click(screen.getByRole("switch", { name: "One file per page" }))
		expect(screen.getByText("Saves 2 files, starting with report (page 4).pdf")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(true)
		fireEvent.click(screen.getByRole("switch", { name: "Password-protect the new files" }))
		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(false)
	})

	it("without owner access keeps the protection, with no switch to leave it off", () => {
		const onExtract = vi.fn()

		render(
			<PdfExtractDialog
				{...copyContext()}
				ownerAccess={false}
				onExtract={onExtract}
				onClose={vi.fn()}
			/>
		)

		expect(screen.queryByRole("switch", { name: "Password-protect the new files" })).toBeNull()
		expect(screen.getByText("The new files keep this PDF's password and restrictions.")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))
		expect(onExtract).toHaveBeenCalledWith(expect.objectContaining({ protect: true }))
	})

	it("without owner access cannot make files of a PDF whose password it cannot carry", () => {
		render(
			<PdfExtractDialog
				{...copyContext()}
				ownerAccess={false}
				passwordUnsupported
				onExtract={vi.fn()}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getByText("This PDF's password can't be given to new files, so they can't be made.")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Extract" }).hasAttribute("disabled")).toBe(true)
	})
})

describe("split dialog", () => {
	it("splits by page count into numbered parts, and by bookmarks", () => {
		const onSplit = vi.fn()
		const props: PdfSplitDialogProps = { ...copyContext(), encrypted: false, bookmarks: [0, 4], onSplit, onClose: vi.fn() }

		render(<PdfSplitDialog {...props} />)

		fireEvent.change(screen.getByRole("spinbutton", { name: "Pages per file" }), { target: { value: "4" } })
		expect(screen.getByText("Saves 3 files, starting with report (part 1).pdf")).toBeTruthy()
		fireEvent.click(screen.getByRole("radio", { name: "By bookmarks" }))
		fireEvent.click(screen.getByRole("button", { name: "Split" }))
		expect(onSplit).toHaveBeenCalledWith({
			parts: [
				{ range: { first: 1, last: 4 }, name: "report (part 1).pdf" },
				{ range: { first: 5, last: 10 }, name: "report (part 2).pdf" }
			],
			protect: false
		})
	})
})

describe("crop", () => {
	it("applies to the chosen pages and says that cropping only hides", () => {
		const onApply = vi.fn()
		const onRemoveMargins = vi.fn()

		render(
			<PdfCropBar
				pageCount={5}
				current={2}
				selected={[]}
				canApply
				onRemoveMargins={onRemoveMargins}
				onApply={onApply}
				onCancel={vi.fn()}
			/>
		)

		expect(screen.getByText("Cropping hides content; it isn't removed.")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Remove white margins" }))
		expect(onRemoveMargins).toHaveBeenCalledWith([2])
		fireEvent.click(screen.getByRole("switch", { name: "Remove content outside the crop" }))
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(onApply).toHaveBeenCalledWith({ pages: [2], removeOutside: true })
	})

	it("places the crop with the keyboard, announces it, applies and cancels", () => {
		const onChange = vi.fn()
		const onCommit = vi.fn()
		const onCancel = vi.fn()
		const onAnnounce = vi.fn()

		render(
			<PdfCropOverlay
				bounds={[0, 0, 600, 800]}
				scale={0.5}
				rect={[100, 100, 300, 300]}
				onChange={onChange}
				onCommit={onCommit}
				onCancel={onCancel}
				onAnnounce={onAnnounce}
			/>
		)

		const area = screen.getByRole("group", { name: "Crop area" })

		fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true })
		expect(onChange).toHaveBeenLastCalledWith([110, 100, 310, 300])
		expect(onAnnounce).toHaveBeenLastCalledWith("Crop 200 by 200 points, 110 from the left and 100 from the top")
		// No live region of its own: the editor's one region says it.
		expect(document.querySelector("[aria-live]")).toBeNull()
		// Each handle is a 24 px target (44 px under a finger), whatever the small square drawn.
		expect(screen.getByRole("button", { name: "Top edge of the crop" }).className).toMatch(/(^| )size-6 .*pointer-coarse:size-11/)
		fireEvent.keyDown(screen.getByRole("button", { name: "Top edge of the crop" }), { key: "ArrowDown" })
		expect(onChange).toHaveBeenLastCalledWith([100, 101, 300, 300])
		act(() => {
			fireEvent.keyDown(area, { key: "Enter" })
		})
		expect(onCommit).toHaveBeenCalledTimes(1)
		fireEvent.keyDown(area, { key: "Escape" })
		expect(onCancel).toHaveBeenCalledTimes(1)
	})
})
