// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { arrangeGroups } from "@/features/presentation/components/ribbon/arrange"
import { insertSmartArtGroups, smartArtPane } from "@/features/presentation/components/ribbon/insertSmartArt"
import { pictureGroups } from "@/features/presentation/components/ribbon/picture"
import { RibbonDialogsHost } from "@/features/presentation/components/ribbon/ribbonDialogs"
import type { PresentationGroups, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { choosePoster } from "@/features/presentation/components/ribbon/video"
import { previewPptxSmartArt } from "@/locales/en/previewPptx/smartart"
import "@/lib/i18n"

// Commands that open a dialog, run from the ribbon's overflow: the overflow closes as the command runs (unmounting the
// control), and the dialog still opens and acts, shown by the host beside the ribbon.

// No room for any group: every one is under More commands.
const size = vi.hoisted(() => ({ width: 40 }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: size.width, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@filen/office/core/smartart", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	SMARTART_LAYOUTS: [{ uniqueId: "urn:test:row", category: "list", nameKey: "previewPptxSmartArtLayoutRow", sample: [] }]
}))

i18n.addResourceBundle("en", "preview", previewPptxSmartArt, true, false)

const EMU = 9525
const ref = slideRef(256)
const FRAME: Xfrm = { x: 100 * EMU, y: 50 * EMU, cx: 600 * EMU, cy: 400 * EMU, rot: 0, flipH: false, flipV: false }
const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo

function renderOf(role: SlideLayer["role"]): SlideRender {
	const layer = { shape: { slide: ref, id: 7 }, role, drawing: {}, matrix: [1, 0, 0, 1, 0, 0], box: { id: 7, xfrm: FRAME } }

	return {
		ref,
		index: 0,
		revision: 1,
		hidden: false,
		background: {},
		layers: [layer],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

function mount(groups: PresentationGroups, role: SlideLayer["role"], selected: boolean): DeckOp[] {
	const ops: DeckOp[] = []
	const selection = createShapeSelection()
	const session = {
		smartArtPreview: vi.fn(() => Promise.resolve({ width: 240, height: 180, close: () => undefined }))
	} as unknown as PresentationSessionApi

	selection.show(ref)

	if (selected) selection.set([7])

	const editor: PresentationRibbonEditor = {
		info: INFO,
		render: renderOf(role),
		selection,
		session,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
		}
	}

	render(
		<>
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "tab", label: "Tab" }]}
				tab="tab"
				onTab={() => undefined}
				file={null}
				groups={groups({ editable: true, phone: true, selection: new Set(), t: i18n.t.bind(i18n), editor })}
			/>
			<RibbonDialogsHost editor={editor} />
		</>
	)

	return ops
}

// Runs the command `name` from More commands; the overflow closes with it.
async function fromOverflow(name: string): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "More commands" }))
	fireEvent.click(await screen.findByRole("button", { name }))
	await waitFor(() => {
		expect(screen.queryByRole("button", { name })).toBeNull()
	})
}

beforeEach(() => {
	smartArtPane.reset()
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe(): void {
				return undefined
			}

			disconnect(): void {
				return undefined
			}
		}
	)
})

afterEach(() => {
	size.width = 40
	cleanup()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("ribbon dialogs run from the overflow", () => {
	it("opens the SmartArt gallery and inserts from it", async () => {
		const ops = mount(insertSmartArtGroups, "shape", false)

		await fromOverflow("Insert a SmartArt graphic")

		const dialog = await screen.findByRole("dialog", { name: "Choose a SmartArt graphic" })

		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }))
			await Promise.resolve()
		})

		expect(ops).toMatchObject([{ family: "smartart", kind: "insert", slide: ref, layout: { uniqueId: "urn:test:row" } }])
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Choose a SmartArt graphic" })).toBeNull()
		})
	})

	it("opens a shape's alt text and sets it", async () => {
		const ops = mount(arrangeGroups, "shape", true)

		await fromOverflow("Alt text…")

		const dialog = await screen.findByRole("dialog", { name: "Alt text" })

		fireEvent.change(within(dialog).getByRole("textbox", { name: "Description" }), { target: { value: "A chart" } })
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		await waitFor(() => {
			expect(ops).toEqual([{ family: "shape", kind: "setAlt", target: { slide: ref, id: 7 }, alt: { descr: "A chart" } }])
		})
	})

	it("opens a picture's crop", async () => {
		mount(pictureGroups, "picture", true)

		await fromOverflow("Crop")

		expect(await screen.findByRole("dialog", { name: "Crop" })).toBeTruthy()
	})
})

// The frame after a dialog closes, when focus has settled.
async function settled(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => requestAnimationFrame(resolve))
		await new Promise(resolve => requestAnimationFrame(resolve))
	})
}

describe("focus after a ribbon dialog closes", () => {
	it("goes to More commands when the dialog was opened from the overflow, which closed", async () => {
		mount(arrangeGroups, "shape", true)

		await fromOverflow("Alt text…")
		fireEvent.click(within(await screen.findByRole("dialog", { name: "Alt text" })).getByRole("button", { name: "Cancel" }))
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Alt text" })).toBeNull()
		})
		await settled()

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "More commands" }))
	})

	it("goes back to the command that opened it while that is still there", async () => {
		size.width = 3000
		const ops = mount(arrangeGroups, "shape", true)
		const opener = screen.getByRole("button", { name: "Alt text…" })

		fireEvent.click(opener)

		const dialog = await screen.findByRole("dialog", { name: "Alt text" })

		fireEvent.change(within(dialog).getByRole("textbox", { name: "Description" }), { target: { value: "A chart" } })
		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		await settled()

		expect(document.activeElement).toBe(opener)
	})
})

describe("a video's poster from a file", () => {
	it("takes the file chosen after the control that asked is gone", () => {
		const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)
		const taken: string[] = []

		choosePoster(file => taken.push(file.name))

		const input = click.mock.contexts[0] as HTMLInputElement

		expect(input.isConnected).toBe(false)
		expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif")
		Object.defineProperty(input, "files", { value: [new File(["x"], "poster.png", { type: "image/png" })] })
		input.dispatchEvent(new Event("change"))

		expect(taken).toEqual(["poster.png"])
	})
})
