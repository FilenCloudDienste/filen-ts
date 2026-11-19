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
import { insertMediaGroups } from "@/features/presentation/components/ribbon/insertMedia"
import { insertObjectsGroups } from "@/features/presentation/components/ribbon/insertObjects"
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

// The drive picker as far as these tests go: a dialog by its title that stays until it is closed.
vi.mock("@/features/drive/components/driveFilePickerDialog", () => ({
	DriveFilePickerDialog: ({ title, onClose }: { title: string; onClose: () => void }) => (
		<div
			role="dialog"
			aria-label={title}
		>
			<button
				type="button"
				onClick={onClose}
			>
				Close picker
			</button>
		</div>
	)
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

// Runs the item `name` of the menu `menu` from More commands, then has the overflow closed (a command in it closes it
// in the browser), which unmounts the menu's control.
async function menuFromOverflow(menu: string, name: string): Promise<void> {
	const more = screen.getByRole("button", { name: "More commands" })

	fireEvent.click(more)
	fireEvent.click(await screen.findByRole("button", { name: menu }))
	fireEvent.click(await screen.findByRole("menuitem", { name }))

	if (more.getAttribute("aria-expanded") === "true") fireEvent.click(more)

	await waitFor(() => {
		expect(screen.queryByRole("menuitem", { name })).toBeNull()
		expect(screen.queryByRole("button", { name: menu })).toBeNull()
	})
}

// A 2 x 1 px PNG's header (what the picture preparation sizes it from).
function png(): File {
	const bytes = new Uint8Array(33)

	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
	new DataView(bytes.buffer).setUint32(16, 2)
	new DataView(bytes.buffer).setUint32(20, 1)
	bytes.set([8, 6, 0, 0, 0], 24)

	return new File([bytes], "photo.png", { type: "image/png" })
}

// The file chooser the last click opened, given `file` once the control that opened it is gone.
function choose(click: { mock: { contexts: unknown[] } }, file: File): void {
	const input = click.mock.contexts.at(-1) as HTMLInputElement

	expect(input.isConnected).toBe(false)
	Object.defineProperty(input, "files", { value: [file] })
	input.dispatchEvent(new Event("change"))
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

describe("Insert and Picture commands run from the overflow", () => {
	it("keeps a picture's drive picker open after the overflow closes", async () => {
		mount(insertObjectsGroups, "shape", false)

		await menuFromOverflow("Pictures", "From Filen…")

		const picker = await screen.findByRole("dialog", { name: "Insert a picture" })

		await settled()
		expect(picker.isConnected).toBe(true)

		fireEvent.click(within(picker).getByRole("button", { name: "Close picker" }))
		await waitFor(() => {
			expect(screen.queryByRole("dialog", { name: "Insert a picture" })).toBeNull()
		})
	})

	it("inserts a picture from this device chosen after the overflow closed", async () => {
		const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)
		const ops = mount(insertObjectsGroups, "shape", false)

		await menuFromOverflow("Pictures", "This device…")
		choose(click, png())

		await waitFor(() => {
			expect(ops).toMatchObject([{ family: "picture", kind: "insert", slide: ref }])
		})
	})

	it("changes a picture to one from this device chosen after the overflow closed", async () => {
		const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)
		const ops = mount(pictureGroups, "picture", true)

		await menuFromOverflow("Change picture", "This device…")
		choose(click, png())

		await waitFor(() => {
			expect(ops).toMatchObject([{ family: "picture", kind: "replace", target: { slide: ref, id: 7 } }])
		})
	})

	it("keeps the custom table size dialog open after the overflow closes, and inserts from it", async () => {
		const ops = mount(insertObjectsGroups, "shape", false)

		await menuFromOverflow("Table", "Insert table…")

		const dialog = await screen.findByRole("dialog", { name: "Insert table" })

		await settled()
		expect(dialog.isConnected).toBe(true)

		fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }))

		await waitFor(() => {
			expect(ops).toMatchObject([{ family: "shape", kind: "insert", slide: ref, shape: { kind: "frame", frame: { kind: "table" } } }])
		})
	})

	it("keeps a video's drive picker open after the overflow closes", async () => {
		mount(insertMediaGroups, "shape", false)

		await menuFromOverflow("Video", "From Filen…")

		const picker = await screen.findByRole("dialog", { name: "Insert a video" })

		await settled()
		expect(picker.isConnected).toBe(true)
	})

	it("reads a video from this device chosen after the overflow closed", async () => {
		const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined)
		const read = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:video")
		const file = new File(["x"], "clip.mp4", { type: "video/mp4" })

		mount(insertMediaGroups, "shape", false)

		await menuFromOverflow("Video", "From this device…")

		expect((click.mock.contexts.at(-1) as HTMLInputElement).accept.startsWith("video/*")).toBe(true)
		choose(click, file)

		expect(read).toHaveBeenCalledWith(file)
	})
})

describe("picture crop and corrections", () => {
	it("takes a decimal comma", async () => {
		const ops = mount(pictureGroups, "picture", true)

		await fromOverflow("Crop")

		const dialog = await screen.findByRole("dialog", { name: "Crop" })

		fireEvent.change(within(dialog).getByRole("textbox", { name: "Top (%)" }), { target: { value: "12,5" } })

		expect(within(dialog).queryByText("Enter a number from 0 to 99.")).toBeNull()

		fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }))

		await waitFor(() => {
			expect(ops).toEqual([{ family: "picture", kind: "crop", target: { slide: ref, id: 7 }, crop: { l: 0, t: 12_500, r: 0, b: 0 } }])
		})
	})

	it("refuses what is no number", async () => {
		mount(pictureGroups, "picture", true)

		await fromOverflow("Crop")

		const dialog = await screen.findByRole("dialog", { name: "Crop" })

		fireEvent.change(within(dialog).getByRole("textbox", { name: "Top (%)" }), { target: { value: "abc" } })

		expect(within(dialog).getByText("Enter a number from 0 to 99.")).toBeTruthy()
	})
})

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
