// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import type { DocxEditToolbarProps } from "@/features/preview/components/docxEditToolbar"
import { TABLE, renderRibbon, ribbonSnapshotIn } from "@/tests/docxRibbonHarness"

// After a ribbon menu, select or collapsed group, focus is back in the document, so what is typed next lands there:
// after a command (the host focuses the document as it runs) and after a choice that runs none.

const size = vi.hoisted(() => ({ width: 2000 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

// The document's editing area, focused when the test starts and by every command (as the host does).
let documentArea: HTMLTextAreaElement

function renderFocused(props: Partial<DocxEditToolbarProps> = {}) {
	documentArea = document.createElement("textarea")
	document.body.append(documentArea)
	documentArea.focus()

	const result = renderRibbon(props)

	result.execute.mockImplementation(() => {
		documentArea.focus()
	})

	return result
}

async function closed(): Promise<void> {
	await waitFor(() => {
		expect(screen.queryByRole("menu")).toBeNull()
		expect(screen.queryByRole("listbox")).toBeNull()
	})
	await new Promise(resolve => setTimeout(resolve, 0))
}

// Picks an option of a select the way a pointer does.
async function choose(label: string, option: string): Promise<void> {
	const trigger = screen.getByRole("combobox", { name: label })

	fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(trigger, { button: 0 })
	fireEvent.click(trigger)

	const item = await screen.findByRole("option", { name: option })

	fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(item, { button: 0 })
	fireEvent.click(item)
}

// Opens `menu` and clicks [role, name] in it.
async function pick(menu: string, [role, name]: readonly [string, string]): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: menu }))
	fireEvent.click(await screen.findByRole(role, { name }))
}

afterEach(() => {
	cleanup()
	documentArea.remove()
	size.width = 2000
})

describe("Focus after the ribbon's menus, selects and collapsed groups", () => {
	it("is back in the document after More formatting ▸ Small caps", async () => {
		const { execute } = renderFocused()

		await pick("More formatting", ["menuitemcheckbox", "Small caps"])
		expect(execute).toHaveBeenCalledWith({ type: "format.smallCaps" })
		await closed()
		expect(document.activeElement).toBe(documentArea)
	})

	it("is back in the document after a font size is picked", async () => {
		const { execute } = renderFocused()

		await choose("Font size", "14")
		expect(execute).toHaveBeenCalledWith({ type: "font.size", halfPoints: 28 })
		await closed()
		expect(document.activeElement).toBe(documentArea)
	})

	it("is back in the document after a paragraph style is picked", async () => {
		const { execute } = renderFocused()

		await choose("Paragraph style", "Heading 1")
		expect(execute).toHaveBeenCalledWith({ type: "style.set", style: "heading1" })
		await closed()
		expect(document.activeElement).toBe(documentArea)
	})

	it("is back in the document after Line spacing ▸ 1.5", async () => {
		const { execute } = renderFocused()

		await pick("Line spacing", ["menuitemradio", "1.5"])
		expect(execute).toHaveBeenCalledWith({ type: "paragraph.lineSpacing", rule: "auto", value: 360 })
		await closed()
		expect(document.activeElement).toBe(documentArea)
	})

	it("is back in the document after Table ▸ Delete ▸ Delete rows", async () => {
		const { execute } = renderFocused({ snapshot: ribbonSnapshotIn({ table: TABLE }) })

		fireEvent.click(screen.getByRole("tab", { name: "Table" }))
		await pick("Delete", ["menuitem", "Delete rows"])
		expect(execute).toHaveBeenCalledWith({ type: "table.row.delete" })
		await closed()
		expect(document.activeElement).toBe(documentArea)
	})

	it("stays in the document after a collapsed group's command, the group closing", async () => {
		size.width = 1024

		const { execute } = renderFocused()

		fireEvent.click(within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("button", { name: "Paragraph" }))
		fireEvent.click(within(await screen.findByRole("toolbar", { name: "Paragraph" })).getByRole("button", { name: "Justify" }))
		expect(execute).toHaveBeenCalledWith({ type: "align.justify" })
		await waitFor(() => {
			expect(screen.queryByRole("toolbar", { name: "Paragraph" })).toBeNull()
		})
		await new Promise(resolve => setTimeout(resolve, 0))
		expect(document.activeElement).toBe(documentArea)
	})
})
