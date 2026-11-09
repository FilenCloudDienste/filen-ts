// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import type { TextCommand, TextDefaults } from "../core/presentation/edit/commands/text"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type RunProps, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { bodyToDoc, docToBody, presentationTextSchema } from "../core/presentation/text/schema"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import {
	copiedRunProps,
	createFormatPainter,
	paintRuns,
	seedRunProps,
	type FormatPainterHost
} from "../react/presentation/edit/text/painter"

// The Format Painter for text: it carries a run's look (not its link or language), paints it over a selection or a
// shape's whole text in one step, and turns itself off after one use unless kept on.

const SLIDE = slideRef(256)
const RED = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } as const

const BODY: TextBody = {
	bodyPr: {},
	paragraphs: [
		{
			pPr: {},
			runs: [
				{ kind: "r", text: "Source", rPr: { b: true, sz: 3200, fill: RED, lang: "en-GB" } },
				{ kind: "r", text: " target", rPr: { i: true, lang: "de-DE", hlinkClick: { kind: "url", href: "https://filen.io" } } }
			]
		}
	]
}

const DEFAULTS: TextDefaults = { paragraph: () => ({ defRPr: { sz: 1800, latin: { typeface: "Calibri" } } }) }

function state(from: number, to: number): EditorState {
	const { doc } = bodyToDoc(BODY)
	const base = EditorState.create({ doc, schema: presentationTextSchema })

	return base.apply(base.tr.setSelection(TextSelection.create(doc, from, to)))
}

function run(command: TextCommand, start: EditorState): EditorState {
	let next = start

	command(start, (tr: Transaction) => {
		next = start.apply(tr)
	})

	return next
}

function seed(shape: ShapeRef, runs: readonly RunProps[]): TextSeed {
	return {
		shape,
		revision: 0,
		body: BODY,
		resolved: [{ pPr: {}, runs }],
		page: {} as TextSeed["page"],
		layout: {} as TextSeed["layout"],
		matrix: []
	}
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("presentation format painter", () => {
	it("copies the first selected character's shown look without its language", () => {
		expect(copiedRunProps(state(1, 9), DEFAULTS)).toEqual({ b: true, sz: 3200, fill: RED, latin: { typeface: "Calibri" } })
	})

	it("paints the look over a selection, keeping the target's link and language", () => {
		const carried = copiedRunProps(state(1, 3), DEFAULTS)
		const painted = run(paintRuns(carried, DEFAULTS), state(7, 14))
		const { origins } = bodyToDoc(BODY)

		expect(docToBody(painted.doc, BODY, origins).paragraphs[0]?.runs[1]).toEqual({
			kind: "r",
			text: " target",
			rPr: {
				b: true,
				sz: 3200,
				fill: RED,
				latin: { typeface: "Calibri" },
				// The carried look is not italic: the target's italic goes.
				i: false,
				lang: "de-DE",
				hlinkClick: { kind: "url", href: "https://filen.io" }
			}
		})
	})

	it("paints the selected shapes' whole text as one step, then turns off", async () => {
		const target: ShapeRef = { slide: SLIDE, id: 7 }
		const source: ShapeRef = { slide: SLIDE, id: 3 }
		const commands: DeckOp[] = []
		const canvas = document.createElement("div")

		canvas.setAttribute("data-fo-shape-edit", "")
		document.body.append(canvas)

		let selected = source
		const host: FormatPainterHost = {
			session: {
				textSeed: shape =>
					Promise.resolve(seed(shape, shape.id === source.id ? [{ u: "sng", sz: 4000, lang: "en-US" }] : [{ sz: 1800 }]))
			},
			text: createTextEditing(),
			targets: () => ({ shapes: [selected], entersText: false }),
			command: op => {
				commands.push(op)

				return Promise.resolve({ ok: true, revision: 1 } as Awaited<ReturnType<FormatPainterHost["command"]>>)
			}
		}
		const painter = createFormatPainter(host.text)

		expect(await painter.copy(host)).toBe(true)
		expect(painter.mode).toBe("once")

		selected = target
		canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
		canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
		await vi.waitFor(() => {
			expect(commands).toHaveLength(1)
		})

		const op = commands[0]

		expect(op?.family === "text" && op.kind === "setText" ? op.target : undefined).toEqual(target)
		expect(
			op?.family === "text" && op.kind === "setText"
				? op.body.paragraphs[0]?.runs.map(each => ("rPr" in each ? each.rPr : undefined))
				: undefined
		).toEqual([
			{ u: "sng", sz: 4000, b: false, lang: "en-GB" },
			{ u: "sng", sz: 4000, i: false, lang: "de-DE", hlinkClick: { kind: "url", href: "https://filen.io" } }
		])
		expect(painter.mode).toBe("off")
	})

	it("stays on after a paint when kept on, and Esc turns it off", async () => {
		const shape: ShapeRef = { slide: SLIDE, id: 3 }
		const commands: DeckOp[] = []
		const canvas = document.createElement("div")

		canvas.setAttribute("data-fo-shape-edit", "")
		document.body.append(canvas)

		const host: FormatPainterHost = {
			session: { textSeed: ref => Promise.resolve(seed(ref, [{ i: true }])) },
			text: createTextEditing(),
			targets: () => ({ shapes: [shape], entersText: false }),
			command: op => {
				commands.push(op)

				return Promise.resolve({ ok: true, revision: 1 } as Awaited<ReturnType<FormatPainterHost["command"]>>)
			}
		}
		const painter = createFormatPainter(host.text)

		await painter.copy(host, true)
		canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
		canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
		await vi.waitFor(() => {
			expect(commands).toHaveLength(1)
		})
		expect(painter.mode).toBe("sticky")

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
		expect(painter.mode).toBe("off")

		// Off: a click on the canvas paints nothing.
		canvas.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
		canvas.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
		await new Promise(resolve => setTimeout(resolve, 5))
		expect(commands).toHaveLength(1)
	})

	it("carries a shape's first resolved run", () => {
		expect(seedRunProps(seed({ slide: SLIDE, id: 1 }, [{ b: true, hlinkClick: { kind: "url", href: "https://x" } }]))).toEqual({
			b: true
		})
	})
})
