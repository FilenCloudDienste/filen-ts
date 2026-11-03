// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, type ShapeSelection } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import {
	activeNodeIndex,
	addNodeOp,
	insertSmartArtGroups,
	insertSmartArtOp,
	nodeMoves,
	SmartArtPreviews,
	smartArtPane
} from "@/features/presentation/components/ribbon/insertSmartArt"
import { smartartDesignGroups } from "@/features/presentation/components/ribbon/smartartDesign"
import { resizedXfrm, smartartFormatGroups } from "@/features/presentation/components/ribbon/smartartFormat"
import type { PresentationGroups, PresentationRibbonContext } from "@/features/presentation/components/ribbon/tabs"
import { previewPptxSmartArt } from "@/locales/en/previewPptx/smartart"
import "@/lib/i18n"

// The SmartArt ribbon against a fake editor: Insert ▸ SmartArt lists our gallery and inserts the chosen layout centred
// on the slide in view (off with its reason where the format cannot hold one); the Design tab's commands act on the
// node chosen in the text pane (else the last), each off where the outline makes it impossible; layouts, styles and
// colours list our gallery's and the file's own; the Format tab sets the frame's size.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 3000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@filen/office/core/smartart", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	SMARTART_LAYOUTS: [
		{ uniqueId: "urn:test:row", category: "list", nameKey: "previewPptxSmartArtLayoutRow", sample: [] },
		{
			uniqueId: "urn:test:column",
			category: "process",
			nameKey: "previewPptxSmartArtLayoutColumn",
			sample: [
				{ level: 1, text: "A" },
				{ level: 2, text: "a" },
				{ level: 1, text: "B" }
			]
		}
	],
	SMARTART_STYLES: [{ uniqueId: "urn:test:flat", nameKey: "previewPptxSmartArtStyleFlat" }],
	SMARTART_COLORS: [{ uniqueId: "urn:test:accent", nameKey: "previewPptxSmartArtColorsAccent" }]
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

// Level 1 "One", level 2 "Two" (under One), level 1 "Three".
const DIAGRAM = {
	root: "{ROOT}",
	nodes: [
		{ id: "{1}", level: 1, type: "node", text: "One" },
		{ id: "{2}", level: 2, type: "node", text: "Two" },
		{ id: "{3}", level: 1, type: "node", text: "Three" }
	],
	layout: "urn:deck:layout",
	style: "urn:test:flat",
	colors: "urn:test:accent",
	deckDefinitions: [
		{ kind: "layout", uniqueId: "urn:deck:layout", title: "Basic block list" },
		{ kind: "colors", uniqueId: "urn:deck:colors", title: "" }
	]
}

function renderOf(revision = 1): SlideRender {
	const layer = {
		shape: { slide: ref, id: 7 },
		role: "smartart",
		drawing: {},
		matrix: [1, 0, 0, 1, 0, 0],
		box: { id: 7, xfrm: FRAME }
	} as unknown as SlideLayer

	return {
		ref,
		index: 0,
		revision,
		hidden: false,
		background: {},
		layers: [layer],
		notesText: "",
		animated: false
	} as unknown as SlideRender
}

interface Mounted {
	readonly ops: DeckOp[]
	readonly selection: ShapeSelection
	readonly session: { smartArtInfo: ReturnType<typeof vi.fn>; smartArtPreview: ReturnType<typeof vi.fn> }
	readonly closed: number[]
}

function mount(groups: PresentationGroups, options: { info?: OpenInfo; editable?: boolean; selected?: boolean } = {}): Mounted {
	const selection = createShapeSelection()
	const ops: DeckOp[] = []
	const closed: number[] = []
	let bitmaps = 0
	const session = {
		smartArtInfo: vi.fn(() => Promise.resolve(DIAGRAM)),
		smartArtPreview: vi.fn(() => {
			const id = ++bitmaps

			return Promise.resolve({ width: 240, height: 180, close: () => closed.push(id) })
		})
	}

	selection.show(ref)

	if (options.selected !== false) selection.set([7])

	const context: PresentationRibbonContext = {
		editable: options.editable ?? true,
		phone: false,
		selection: new Set(["smartart"]),
		t: i18n.t.bind(i18n),
		editor: {
			info: options.info ?? INFO,
			render: renderOf(),
			selection,
			session: session as unknown as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}
	}

	render(
		<OfficeRibbon
			label="Ribbon"
			commandsLabel="Commands"
			tabs={[{ id: "tab", label: "Tab" }]}
			tab="tab"
			onTab={() => undefined}
			file={null}
			groups={groups(context)}
		/>
	)

	return { ops, selection, session, closed }
}

// The entry at `index`, which the test expects to be there.
function at<T>(list: readonly T[], index: number): T {
	const entry = list[index]

	if (entry === undefined) throw new Error(`no entry ${String(index)}`)

	return entry
}

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

function button(name: string): HTMLButtonElement {
	return within(commands()).getByRole<HTMLButtonElement>("button", { name })
}

beforeEach(() => {
	smartArtPane.reset()
	// Every tile is in view at once (happy-dom lays nothing out).
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			private readonly callback: (entries: { isIntersecting: boolean }[]) => void

			constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
				this.callback = callback
			}

			observe(): void {
				queueMicrotask(() => {
					this.callback([{ isIntersecting: true }])
				})
			}

			disconnect(): void {
				return undefined
			}
		}
	)
})

afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe("SmartArt outline rules", () => {
	it("promotes below the top level and demotes or moves only past a sibling", () => {
		const nodes = DIAGRAM.nodes as Parameters<typeof nodeMoves>[0]

		expect(nodeMoves(nodes, 0)).toEqual({ promote: false, demote: false, up: false, down: true })
		// "Two" is One's only child.
		expect(nodeMoves(nodes, 1)).toEqual({ promote: true, demote: false, up: false, down: false })
		expect(nodeMoves(nodes, 2)).toEqual({ promote: false, demote: true, up: true, down: false })
		expect(nodeMoves(nodes, -1)).toEqual({ promote: false, demote: false, up: false, down: false })
	})

	it("acts on the chosen node, else the last, and adds an empty diagram's first node under its root", () => {
		const info = DIAGRAM as Parameters<typeof activeNodeIndex>[0] & object
		const target = { slide: ref, id: 7 }

		expect(activeNodeIndex(info, "{2}")).toBe(1)
		expect(activeNodeIndex(info, "{gone}")).toBe(2)
		expect(activeNodeIndex(info, undefined)).toBe(2)

		const empty = { ...info, nodes: [] }

		expect(addNodeOp(target, empty, -1, "after", "{N}")).toEqual({
			family: "smartart",
			kind: "addNode",
			target,
			relativeTo: "{ROOT}",
			position: "below",
			id: "{N}"
		})
		expect(addNodeOp(target, empty, -1, "before", "{N}")).toBeUndefined()
		expect(addNodeOp(target, info, 0, "above", "{N}", "x")).toMatchObject({ relativeTo: "{1}", position: "above", text: "x" })
	})
})

describe("SmartArt pane store", () => {
	it("reads an outline once per diagram and render, and again for another deck's session with the same refs", async () => {
		const first = { smartArtInfo: vi.fn(() => Promise.resolve(DIAGRAM)) }
		const second = { smartArtInfo: vi.fn(() => Promise.resolve({ ...DIAGRAM, nodes: [] })) }
		const target = { slide: ref, id: 7 }

		smartArtPane.request(first as unknown as PresentationSessionApi, target, 1)
		smartArtPane.request(first as unknown as PresentationSessionApi, target, 1)
		await waitFor(() => {
			expect(smartArtPane.getSnapshot().status).toBe("ready")
		})
		smartArtPane.request(second as unknown as PresentationSessionApi, target, 1)
		await waitFor(() => {
			expect(smartArtPane.getSnapshot().info?.nodes).toEqual([])
		})
		expect(first.smartArtInfo).toHaveBeenCalledTimes(1)
		expect(second.smartArtInfo).toHaveBeenCalledTimes(1)
	})
})

describe("Insert ▸ SmartArt", () => {
	it("inserts the chosen layout centred on the slide in view with its sample outline, and opens the text pane", async () => {
		const { ops, selection, session } = mount(insertSmartArtGroups, { selected: false })

		fireEvent.click(button("Insert a SmartArt graphic"))

		const dialog = await screen.findByRole("dialog", { name: "Choose a SmartArt graphic" })
		const tiles = within(within(dialog).getByRole("group", { name: "Layouts" })).getAllByRole("button")

		expect(tiles.map(tile => tile.textContent)).toEqual(["Row of blocks", "Column of blocks"])
		await waitFor(() => {
			expect(session.smartArtPreview).toHaveBeenCalledTimes(2)
		})

		fireEvent.click(at(tiles, 1))
		await act(async () => {
			fireEvent.click(within(dialog).getByRole("button", { name: "Insert" }))
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{
				family: "smartart",
				kind: "insert",
				slide: ref,
				shape: {
					id: 0,
					name: "Diagram",
					hidden: false,
					kind: "frame",
					xfrm: { x: 160 * EMU, y: 54 * EMU, cx: 640 * EMU, cy: 432 * EMU, rot: 0, flipH: false, flipV: false }
				},
				layout: { uniqueId: "urn:test:column", source: "gallery" },
				texts: ["A", "\ta", "B"]
			}
		])
		// The next render's new frame is selected.
		expect(selection.getSnapshot().pending?.before).toEqual(new Set([7]))
		await waitFor(() => {
			expect(smartArtPane.getSnapshot().open).toBe(true)
		})
	})

	it("starts a layout without sample text with three empty nodes", () => {
		const op = insertSmartArtOp(ref, { cx: 900, cy: 600 }, { uniqueId: "u", category: "list", nameKey: "k", sample: [] }, "Diagram")

		expect(op).toMatchObject({ texts: ["", "", ""], shape: { xfrm: { x: 150, y: 60, cx: 600, cy: 480 } } })
	})

	it("closes every preview bitmap when the gallery closes, one answered later on arrival", async () => {
		const closed: string[] = []
		let late: ((bitmap: { width: number; height: number; close: () => void }) => void) | undefined
		const session = {
			smartArtPreview: vi.fn((layout: { uniqueId: string }) =>
				layout.uniqueId === "late"
					? new Promise<{ width: number; height: number; close: () => void }>(resolve => {
							late = resolve
						})
					: Promise.resolve({ width: 1, height: 1, close: () => closed.push(layout.uniqueId) })
			)
		}
		const previews = new SmartArtPreviews(session)
		const request = { layout: { uniqueId: "a", source: "gallery" as const }, widthPx: 240 }

		await previews.get(request)
		await previews.get(request)
		expect(session.smartArtPreview).toHaveBeenCalledTimes(1)

		void previews.get({ ...request, layout: { uniqueId: "late", source: "gallery" } })
		previews.close()
		await Promise.resolve()
		expect(closed).toEqual(["a"])
		late?.({ width: 1, height: 1, close: () => closed.push("late") })
		await waitFor(() => {
			expect(closed).toEqual(["a", "late"])
		})
	})

	it("is off with its reason in a deck that cannot hold SmartArt, and absent in the viewer", () => {
		mount(insertSmartArtGroups, { info: { ...INFO, format: "odp" } })

		const off = within(commands()).getByRole("button", { name: /Insert a SmartArt graphic/ })

		expect(off.getAttribute("aria-label")).toContain("PowerPoint (.pptx)")
		expect(off.getAttribute("aria-disabled")).toBe("true")
		cleanup()
		expect(insertSmartArtGroups({ editable: false, phone: false, selection: new Set(), t: i18n.t.bind(i18n) })).toEqual([])
	})
})

describe("SmartArt Design tab", () => {
	it("turns each command off where the chosen node cannot take it", async () => {
		const { session } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Demote").disabled).toBe(false)
		})
		// The last node ("Three") by default.
		expect(button("Promote").disabled).toBe(true)
		expect(button("Move up").disabled).toBe(false)
		expect(button("Move down").disabled).toBe(true)

		act(() => {
			smartArtPane.setNode("{2}")
		})
		expect(button("Promote").disabled).toBe(false)
		expect(button("Demote").disabled).toBe(true)
		expect(button("Move up").disabled).toBe(true)
		// One read for the one render.
		expect(session.smartArtInfo).toHaveBeenCalledTimes(1)
	})

	it("adds a shape after the chosen node with a new id and acts on it next", async () => {
		const { ops } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Demote").disabled).toBe(false)
		})
		act(() => {
			smartArtPane.setNode("{1}")
		})
		fireEvent.click(button("Add shape"))
		await act(async () => {
			fireEvent.click(await screen.findByRole("menuitem", { name: "Add shape after" }))
			await Promise.resolve()
		})

		expect(ops).toHaveLength(1)
		expect(ops[0]).toMatchObject({
			family: "smartart",
			kind: "addNode",
			target: { slide: ref, id: 7 },
			relativeTo: "{1}",
			position: "after"
		})

		const id = (ops[0] as { id: string }).id

		expect(id).toMatch(/^\{[0-9A-F-]{36}\}$/)
		await waitFor(() => {
			expect(smartArtPane.getSnapshot().node).toBe(id)
		})
	})

	it("sends the text pane's unsent text first, in the same undo step", async () => {
		const { ops } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Demote").disabled).toBe(false)
		})
		smartArtPane.setDraft(
			"{3}",
			() => ({ family: "smartart", kind: "setNodeText", target: { slide: ref, id: 7 }, node: "{3}", text: "Thr" }),
			() => undefined
		)
		fireEvent.click(button("Demote"))
		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).toEqual({
			family: "batch",
			kind: "batch",
			ops: [
				{ family: "smartart", kind: "setNodeText", target: { slide: ref, id: 7 }, node: "{3}", text: "Thr" },
				{ family: "smartart", kind: "demote", target: { slide: ref, id: 7 }, node: "{3}" }
			]
		})
	})

	it("lists our layouts and the file's own, and switches to the file's own within the file", async () => {
		const { ops } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Change layout").disabled).toBe(false)
		})
		fireEvent.click(button("Change layout"))

		const items = await screen.findAllByRole("menuitemradio")

		expect(items.map(item => item.textContent)).toEqual(["Row of blocks", "Column of blocks", "Basic block list"])
		expect(items[2]?.getAttribute("aria-checked")).toBe("true")

		await act(async () => {
			fireEvent.click(at(items, 0))
			await Promise.resolve()
		})
		expect(ops).toEqual([
			{ family: "smartart", kind: "setLayout", target: { slide: ref, id: 7 }, def: { uniqueId: "urn:test:row", source: "gallery" } }
		])
	})

	it("names a colour set the file brings without a title by its id", async () => {
		const { ops } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Change colors").disabled).toBe(false)
		})
		fireEvent.click(button("Change colors"))

		const items = await screen.findAllByRole("menuitemradio")

		expect(items.map(item => item.textContent)).toEqual(["Accent color", "Untitled (urn:deck:colors)"])
		await act(async () => {
			fireEvent.click(at(items, 1))
			await Promise.resolve()
		})
		expect(ops).toEqual([
			{ family: "smartart", kind: "setColors", target: { slide: ref, id: 7 }, def: { uniqueId: "urn:deck:colors", source: "deck" } }
		])
	})

	it("closes the layout, style and colours menus on a choice, giving focus back to the trigger", async () => {
		const { ops } = mount(smartartDesignGroups)

		await waitFor(() => {
			expect(button("Change layout").disabled).toBe(false)
		})

		for (const [trigger, index] of [
			["Change layout", 0],
			// The current style: no op, and the menu still closes.
			["Style", 0],
			["Change colors", 1]
		] as const) {
			const opener = button(trigger)

			fireEvent.click(opener)

			const items = await screen.findAllByRole("menuitemradio")

			await act(async () => {
				fireEvent.click(at(items, index))
				await Promise.resolve()
			})
			await waitFor(() => {
				expect(screen.queryByRole("menu")).toBeNull()
			})
			expect(opener.getAttribute("aria-expanded")).not.toBe("true")
			await waitFor(() => {
				expect(document.activeElement).toBe(opener)
			})
		}

		expect(ops.map(op => op.kind)).toEqual(["setLayout", "setColors"])
	})

	it("toggles the text pane", () => {
		mount(smartartDesignGroups)

		fireEvent.click(button("Text pane"))
		expect(smartArtPane.getSnapshot().open).toBe(true)
		expect(button("Text pane").getAttribute("aria-pressed")).toBe("true")
	})
})

describe("SmartArt Format tab", () => {
	it("sets the frame's width from the field, keeping its top left corner", () => {
		const { ops } = mount(smartartFormatGroups)
		const width = within(commands()).getByRole("textbox", { name: /^Width/ })

		fireEvent.change(width, { target: { value: "10" } })
		fireEvent.keyDown(width, { key: "Enter" })

		expect(ops).toHaveLength(1)
		expect(ops[0]).toMatchObject({
			family: "shape",
			kind: "setXfrm",
			target: { slide: ref, id: 7 },
			xfrm: { x: FRAME.x, y: FRAME.y, cy: FRAME.cy }
		})

		const cx = (ops[0] as { xfrm: Xfrm }).xfrm.cx

		// 10 cm or 10 in, whichever the test's locale measures in.
		expect([3_600_000, 9_144_000]).toContain(cx)
	})

	it("cancels a typed width with Escape without sending it, the key taken so focus stays", () => {
		const { ops } = mount(smartartFormatGroups)
		const width = within(commands()).getByRole<HTMLInputElement>("textbox", { name: /^Width/ })
		const shown = width.value

		fireEvent.change(width, { target: { value: "10" } })
		expect(fireEvent.keyDown(width, { key: "Escape" })).toBe(false)
		expect(width.value).toBe(shown)
		fireEvent.blur(width)
		expect(ops).toEqual([])
	})

	it("keeps the aspect a file locks, and refuses lengths out of range", () => {
		expect(resizedXfrm(FRAME, "cx", "", "cm", false)).toBeUndefined()
		expect(resizedXfrm(FRAME, "cx", "0", "cm", false)).toBeUndefined()
		expect(resizedXfrm(FRAME, "cx", "500", "in", false)).toBeUndefined()
		expect(resizedXfrm(FRAME, "cy", "2", "in", true)).toMatchObject({
			cy: 1_828_800,
			cx: Math.round((FRAME.cx * 1_828_800) / FRAME.cy)
		})
	})
})
