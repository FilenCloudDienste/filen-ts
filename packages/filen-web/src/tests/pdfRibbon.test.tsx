// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createRef } from "react"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { EraserIcon, PenLineIcon } from "lucide-react"
import type { PdfViewerState } from "@filen/office/dom/pdf"
import type { PdfDomDocument } from "@filen/office/react/pdf"
import "@/lib/i18n"

// The PDF ribbon: the viewer's commands first on Home, each tab's tools in their groups, a mode tool pressed while
// active, a tool not offered carrying its reason, and Undo / Redo / Save / Discard once the document has changes.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 4000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const { PdfRibbon } = await import("@/features/pdf/ribbon/pdfRibbon")
const { toolEnabled } = await import("@/features/pdf/tools/registry")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

type Props = Parameters<typeof PdfRibbon>[0]
type History = NonNullable<Props["history"]>

const STATE: PdfViewerState = {
	page: 1,
	pageCount: 3,
	scale: 1,
	zoom: 100,
	zoomMode: "custom",
	rotation: 0,
	find: { open: false, query: "", caseSensitive: false, done: true, count: 0, capped: false, active: -1 }
}

// The bar reads nothing from the document without an outline.
function documentStub(): PdfDomDocument {
	return { numPages: 3 } as unknown as PdfDomDocument
}

function setup(overrides: Partial<Props>): Props {
	return {
		state: STATE,
		dispatch: vi.fn(),
		document: documentStub(),
		outline: [],
		findFocus: 0,
		onFindClosed: vi.fn(),
		onDownload: null,
		onPrint: undefined,
		onProperties: vi.fn(),
		pageInputRef: createRef<HTMLInputElement>(),
		tools: [
			{
				id: "draw",
				ribbon: { tab: "home", group: "markup", order: 1 },
				labelKey: "previewPdfUndo",
				icon: PenLineIcon,
				toolClass: "annotate",
				actionIds: [],
				actions: [],
				enabledWhen: () => ({ enabled: true }),
				commands: []
			},
			{
				id: "forms.reset",
				ribbon: { tab: "fillSign", group: "form", order: 900 },
				labelKey: "previewPdfClearForm",
				icon: EraserIcon,
				toolClass: "formFill",
				actionIds: [],
				actions: [],
				enabledWhen: policy => toolEnabled("formFill", policy),
				commands: [],
				run: context => {
					context.finish()
				}
			}
		],
		policy: { editable: true, online: true, tools: null },
		toolContext: { edit: vi.fn(), finish: vi.fn() },
		activeTool: null,
		onActivateTool: vi.fn(),
		onPrefetch: vi.fn(),
		history: null,
		...overrides
	}
}

function history(overrides: Partial<History>): History {
	return {
		dirty: true,
		canUndo: true,
		canRedo: false,
		saving: false,
		canSave: true,
		undo: vi.fn(),
		redo: vi.fn(),
		save: vi.fn(),
		saveAsCopy: vi.fn(),
		discard: vi.fn(),
		...overrides
	}
}

afterEach(() => {
	cleanup()
})

describe("PdfRibbon", () => {
	it("shows every tab and the viewer's commands before the Home tools", () => {
		const props = setup({})

		render(<PdfRibbon {...props} />)

		const tabs = screen.getAllByRole("tab").map(tab => tab.textContent)

		expect(tabs).toEqual(["Home", "Fill & Sign", "Pages", "Protect", "Tools"])

		const commands = screen.getByRole("toolbar", { name: "PDF commands" })
		const groups = Array.from(commands.querySelectorAll("[data-ribbon-group]")).map(group => group.getAttribute("data-ribbon-group"))

		expect(groups[0]).toBe("pages")
		expect(groups.at(-1)).toBe("tool-markup")
	})

	it("activates a mode tool, presses it while active, and prefetches on hover", () => {
		const props = setup({})
		const { rerender } = render(<PdfRibbon {...props} />)
		const draw = screen.getByRole("button", { name: "Undo" })

		fireEvent.pointerOver(draw)
		fireEvent.click(draw)

		expect(props.onPrefetch).toHaveBeenCalled()
		expect(props.onActivateTool).toHaveBeenCalledWith("draw")

		rerender(
			<PdfRibbon
				{...props}
				activeTool="draw"
			/>
		)

		const pressed = screen.getByRole("button", { name: "Undo" })

		expect(pressed.getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(pressed)

		expect(props.onActivateTool).toHaveBeenLastCalledWith(null)
	})

	it("runs an action tool and shows why one is not offered", () => {
		const finish = vi.fn()
		const props = setup({ toolContext: { edit: vi.fn(), finish } })
		const { rerender } = render(<PdfRibbon {...props} />)

		fireEvent.click(screen.getByRole("tab", { name: "Fill & Sign" }))
		fireEvent.click(screen.getByRole("button", { name: "Clear form" }))

		expect(finish).toHaveBeenCalled()

		rerender(
			<PdfRibbon
				{...props}
				policy={{ editable: true, online: false, tools: null }}
			/>
		)

		const off = screen.getByRole("button", { name: "Clear form" })

		expect(off).toHaveProperty("disabled", true)
		expect(off.getAttribute("title")).toBe("You're offline.")
	})

	it("prefetches the editor when Tools is chosen", () => {
		const props = setup({})

		render(<PdfRibbon {...props} />)
		fireEvent.click(screen.getByRole("tab", { name: "Tools" }))

		expect(props.onPrefetch).toHaveBeenCalledTimes(1)
	})

	it("shows Undo, Redo, Save and Discard only once there is history (a save keeps it)", async () => {
		const clean = setup({ history: history({ dirty: false, canUndo: false, canRedo: false }) })
		const { rerender } = render(<PdfRibbon {...clean} />)

		expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull()

		const save = vi.fn()
		const discard = vi.fn()

		rerender(
			<PdfRibbon
				{...clean}
				history={history({ save, discard })}
			/>
		)

		expect(screen.getByRole("button", { name: "Redo" })).toHaveProperty("disabled", true)

		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		expect(save).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("button", { name: "Discard changes" }))

		const dialog = await screen.findByRole("alertdialog")

		expect(discard).not.toHaveBeenCalled()

		fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }))

		await waitFor(() => {
			expect(discard).toHaveBeenCalledTimes(1)
		})
	})

	it("disables saving while it may not run", () => {
		const props = setup({ history: history({ canSave: false }) })

		render(<PdfRibbon {...props} />)

		expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true)
		expect(screen.getByRole("button", { name: "More save options" })).toHaveProperty("disabled", true)
	})
})
