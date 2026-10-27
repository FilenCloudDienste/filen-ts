// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import i18n from "i18next"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { smartArtPane } from "@/features/presentation/components/ribbon/insertSmartArt"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { SmartArtPrompts, SmartArtTextPane } from "@/features/presentation/components/smartartTextPane"
import { previewPptxSmartArt } from "@/locales/en/previewPptx/smartart"
import "@/lib/i18n"

// The SmartArt text pane: the selected diagram's outline, one field per node indented by level; typed text is sent
// as one setNodeText when the field is left or typing pauses, never per key; Enter splits into a new node after,
// Tab and Shift+Tab demote and promote, Alt+Shift+arrows move, Backspace in an empty node removes it; the outline is
// read again for each new render of the slide and never otherwise.

i18n.addResourceBundle("en", "preview", previewPptxSmartArt, true, false)

const EMU = 9525
const ref = slideRef(256)
const target = { slide: ref, id: 7 }
const FRAME: Xfrm = { x: 0, y: 0, cx: 600 * EMU, cy: 400 * EMU, rot: 0, flipH: false, flipV: false }
const INFO = {
	format: "pptx",
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	editable: true
} as unknown as OpenInfo

function diagram(texts: readonly [string, number][]) {
	return {
		root: "{ROOT}",
		nodes: texts.map(([text, level], index) => ({ id: `{${String(index + 1)}}`, level, type: "node", text })),
		deckDefinitions: []
	}
}

function renderOf(revision: number): SlideRender {
	const layer = {
		shape: target,
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

let ops: DeckOp[]
let info: ReturnType<typeof diagram>
const smartArtInfo = vi.fn(() => Promise.resolve(info))

function mount() {
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set([7])
	ops = []

	// One deck: one session across renders.
	const session = { smartArtInfo } as unknown as PresentationSessionApi

	const editorAt = (revision: number): PresentationRibbonEditor => ({
		info: INFO,
		render: renderOf(revision),
		selection,
		session,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		}
	})
	const view = render(
		<SmartArtTextPane
			editor={editorAt(1)}
			editable
			phone={false}
		/>
	)

	return {
		// The slide renders again after a command.
		rerender: (revision: number) => {
			view.rerender(
				<SmartArtTextPane
					editor={editorAt(revision)}
					editable
					phone={false}
				/>
			)
		}
	}
}

function field(name: string): HTMLTextAreaElement {
	return screen.getByRole<HTMLTextAreaElement>("textbox", { name })
}

beforeEach(() => {
	smartArtPane.reset()
	smartArtPane.setOpen(true)
	smartArtInfo.mockClear()
	info = diagram([
		["One", 1],
		["Two", 2],
		["Three", 1]
	])
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

// WCAG 2 contrast of a CSS rgb()/rgba() colour (alpha over the backdrop) against an opaque backdrop.
function contrast(css: string, backdrop: readonly [number, number, number]): number {
	const [r = 0, g = 0, b = 0, a = 1] = (/rgba?\(([^)]*)\)/u.exec(css)?.[1] ?? "").split(",").map(Number)
	const channel = (value: number): number => {
		const c = value / 255

		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
	}
	const luminance = (rgb: readonly number[]): number =>
		0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0)
	const over = [r, g, b].map((value, k) => value * a + (backdrop[k] ?? 0) * (1 - a))
	const [hi, lo] = [luminance(over), luminance(backdrop)].sort((x, y) => y - x)

	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

describe("SmartArt text prompts", () => {
	it("shows the localized prompt where the selected diagram's empty nodes go, and none once every node has text", async () => {
		const selection = createShapeSelection()

		selection.show(ref)
		selection.set([7])
		info = { ...diagram([["", 1]]), prompts: [{ x: 9525 * 10, y: 9525 * 20, w: 9525 * 100, h: 9525 * 40 }] } as never

		const editor: PresentationRibbonEditor = {
			info: INFO,
			render: renderOf(1),
			selection,
			session: { smartArtInfo } as unknown as PresentationSessionApi,
			command: () => Promise.resolve({ ok: true, revision: 2, dirty: true })
		}
		const view = render(
			<SmartArtPrompts
				editor={editor}
				scale={1}
			/>
		)
		const prompt = await screen.findByText("[Text]")

		expect(prompt.style.left).toBe("10px")
		expect(prompt.style.width).toBe("100px")
		// Legible on any node fill: light text in a dark halo, the pair at WCAG AA (4.5:1) or more.
		expect(prompt.style.textShadow).toMatch(/rgb\(0, 0, 0\)|#000/u)
		expect(contrast(prompt.style.color, [0, 0, 0])).toBeGreaterThanOrEqual(4.5)

		info = diagram([["One", 1]])
		view.rerender(
			<SmartArtPrompts
				editor={{ ...editor, render: renderOf(2) }}
				scale={1}
			/>
		)
		await waitFor(() => {
			expect(screen.queryByText("[Text]")).toBeNull()
		})
	})
})

describe("SmartArt text pane", () => {
	it("lists the outline, one field per node indented by its level", async () => {
		mount()

		await screen.findByRole("textbox", { name: "Shape 1, level 1" })
		expect(screen.getAllByRole("textbox").map(each => (each as HTMLTextAreaElement).value)).toEqual(["One", "Two", "Three"])
		expect(field("Shape 2, level 2").parentElement?.style.paddingInlineStart).toBe("14px")
		expect(screen.getByRole("complementary", { name: /Type your text here/ })).toBeTruthy()
	})

	it("sends typed text once when the field is left, and once after a pause, never per key", async () => {
		mount()

		const one = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Shape 1, level 1" })

		vi.useFakeTimers()
		fireEvent.focus(one)
		fireEvent.change(one, { target: { value: "On" } })
		fireEvent.change(one, { target: { value: "Onc" } })
		fireEvent.change(one, { target: { value: "Once" } })
		expect(ops).toEqual([])

		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(ops).toEqual([{ family: "smartart", kind: "setNodeText", target, node: "{1}", text: "Once" }])

		fireEvent.change(one, { target: { value: "Once more" } })
		fireEvent.blur(one)
		// Leaving sends at once; the pause after it sends nothing more.
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(ops).toEqual([
			{ family: "smartart", kind: "setNodeText", target, node: "{1}", text: "Once" },
			{ family: "smartart", kind: "setNodeText", target, node: "{1}", text: "Once more" }
		])
	})

	it("splits the text at the caret into a new node after on Enter, in one undo step, and focuses it", async () => {
		const { rerender } = mount()
		const one = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Shape 1, level 1" })

		fireEvent.focus(one)
		fireEvent.change(one, { target: { value: "Unotwo" } })
		one.setSelectionRange(3, 3)
		await act(async () => {
			fireEvent.keyDown(one, { key: "Enter" })
			await Promise.resolve()
		})

		expect(ops).toHaveLength(1)

		const batch = ops[0] as unknown as { ops: DeckOp[] }
		const added = batch.ops[1] as { id: string }

		expect(batch).toEqual({
			family: "batch",
			kind: "batch",
			ops: [
				{ family: "smartart", kind: "setNodeText", target, node: "{1}", text: "Uno" },
				{ family: "smartart", kind: "addNode", target, relativeTo: "{1}", position: "after", text: "two", id: added.id }
			]
		})

		// The worker's next outline lists the new node; it takes the focus.
		info = {
			...info,
			nodes: [info.nodes[0], info.nodes[1], { id: added.id, level: 1, type: "node", text: "two" }, info.nodes[2]].filter(
				(node): node is (typeof info.nodes)[number] => node !== undefined
			)
		}
		rerender(2)
		await waitFor(() => {
			expect(document.activeElement).toBe(field("Shape 3, level 1"))
		})
		expect(field("Shape 3, level 1").selectionStart).toBe(0)
	})

	it("demotes on Tab, promotes on Shift+Tab, moves on Alt+Shift+arrows, only where the outline allows", async () => {
		mount()

		const three = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Shape 3, level 1" })
		const two = field("Shape 2, level 2")

		await act(async () => {
			fireEvent.keyDown(three, { key: "Tab" })
			fireEvent.keyDown(three, { key: "Tab", shiftKey: true })
			fireEvent.keyDown(two, { key: "Tab", shiftKey: true })
			fireEvent.keyDown(three, { key: "ArrowUp", altKey: true, shiftKey: true })
			fireEvent.keyDown(three, { key: "ArrowDown", altKey: true, shiftKey: true })
			await Promise.resolve()
		})

		expect(ops).toEqual([
			{ family: "smartart", kind: "demote", target, node: "{3}" },
			{ family: "smartart", kind: "promote", target, node: "{2}" },
			{ family: "smartart", kind: "moveNode", target, node: "{3}", direction: "up" }
		])
	})

	it("removes an empty node on Backspace and focuses the one before it", async () => {
		info = diagram([
			["One", 1],
			["", 1]
		])

		const { rerender } = mount()
		const empty = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Shape 2, level 1" })

		await act(async () => {
			fireEvent.keyDown(empty, { key: "Backspace" })
			await Promise.resolve()
		})
		expect(ops).toEqual([{ family: "smartart", kind: "removeNode", target, node: "{2}" }])

		info = diagram([["One", 1]])
		rerender(2)
		await waitFor(() => {
			expect(document.activeElement).toBe(field("Shape 1, level 1"))
		})
		expect(field("Shape 1, level 1").selectionStart).toBe(3)
	})

	it("reads the outline once per render of the slide, and again only for a new one", async () => {
		const { rerender } = mount()

		await screen.findByRole("textbox", { name: "Shape 1, level 1" })
		rerender(1)
		rerender(1)
		expect(smartArtInfo).toHaveBeenCalledTimes(1)

		info = diagram([["Changed", 1]])
		rerender(2)
		await waitFor(() => {
			expect(screen.getAllByRole("textbox").map(each => (each as HTMLTextAreaElement).value)).toEqual(["Changed"])
		})
		expect(smartArtInfo).toHaveBeenCalledTimes(2)
	})

	it("adds the first node of an empty diagram under its root, and shows nothing while closed", async () => {
		info = diagram([])
		mount()

		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "Add a shape" }))
			await Promise.resolve()
		})
		expect(ops).toEqual([
			{
				family: "smartart",
				kind: "addNode",
				target,
				relativeTo: "{ROOT}",
				position: "below",
				id: expect.stringMatching(/^\{/) as string
			}
		])

		act(() => {
			smartArtPane.setOpen(false)
		})
		expect(screen.queryByRole("complementary")).toBeNull()
	})
})
