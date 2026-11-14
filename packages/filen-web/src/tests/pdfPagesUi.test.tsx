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
		passwordUnsupported: false,
		signed: true,
		progress: undefined,
		online: true
	}
}

describe("extract dialog", () => {
	it("extracts the selection under a free name, keeping the password", () => {
		const onExtract = vi.fn()

		render(
			<PdfExtractDialog
				{...copyContext()}
				onExtract={onExtract}
				onClose={vi.fn()}
			/>
		)

		expect(screen.getByText("Saves report (pages 2-3 2).pdf")).toBeTruthy()
		expect(screen.getByText("Signatures aren't copied. Where a signature shows on a page, its picture stays.")).toBeTruthy()
		fireEvent.click(screen.getByRole("switch", { name: "Delete pages after extracting" }))
		fireEvent.click(screen.getByRole("button", { name: "Extract" }))
		expect(onExtract).toHaveBeenCalledWith({
			files: [
				{
					ranges: [{ first: 2, last: 3 }],
					name: "report (pages 2-3 2).pdf"
				}
			],
			deletes: [1, 2],
			protect: true
		})
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

		render(
			<PdfCropOverlay
				bounds={[0, 0, 600, 800]}
				scale={0.5}
				rect={[100, 100, 300, 300]}
				onChange={onChange}
				onCommit={onCommit}
				onCancel={onCancel}
			/>
		)

		const area = screen.getByRole("group", { name: "Crop area" })

		fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true })
		expect(onChange).toHaveBeenLastCalledWith([110, 100, 310, 300])
		expect(screen.getByText("Crop 200 by 200 points, 110 from the left and 100 from the top")).toBeTruthy()
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
