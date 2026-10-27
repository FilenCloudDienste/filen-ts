import { afterEach, describe, expect, it, vi } from "vitest"
import { rgba } from "../core/drawingml/index"
import { toggleRunFlag } from "../core/presentation/edit/commands/text"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { bodyToDoc, docToBody } from "../core/presentation/text/schema"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { COMMIT_IDLE_MS, TextEditController } from "../react/presentation/edit/text/controller"
import { LayoutMap } from "../react/presentation/edit/text/layoutMap"
import { FakeMeasurer, testFont } from "./textFixtures"

// The editor's view of a body over the worker's layout: document positions map to laid-out offsets past the bullet
// marker and through atoms; carets, selections and clicks land where the worker placed the glyphs; the controller
// lays out every change, commits setText after 150 ms idle and before anything else, coalesces typing into one burst,
// and takes undo from the worker (reseeding the view only when the step touched its body).

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }
const BOX = { width: 400, height: 300 }
const SHAPE: ShapeRef = { slide: slideRef(3), id: 2 }

function laid(body: TextBody) {
	const result = layoutBody(resolveBody(body, CONTEXT), BOX, ENV)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(body: TextBody, revision = 1): TextSeed {
	const { page, layout } = laid(body)

	return {
		shape: SHAPE,
		revision,
		body,
		resolved: body.paragraphs.map(paragraph => ({
			pPr: paragraph.pPr,
			runs: paragraph.runs.map(run => (run.kind === "opaque" ? {} : run.rPr))
		})),
		page,
		layout,
		matrix: [1, 0, 0, 1, 10, 20]
	}
}

function plain(...paragraphs: string[]): TextBody {
	return { bodyPr: {}, paragraphs: paragraphs.map(text => ({ pPr: {}, runs: [{ kind: "r", text, rPr: { sz: 1800 } }] })) }
}

function mapOf(body: TextBody): LayoutMap {
	const { doc, origins } = bodyToDoc(body)

	return new LayoutMap(doc, docToBody(doc, body, origins), laid(body).layout, new MeasureCache(new FakeMeasurer()))
}

describe("presentation text editor layout map", () => {
	it("maps document positions past a bullet marker and through fields and breaks", () => {
		const body: TextBody = {
			bodyPr: {},
			paragraphs: [
				{
					pPr: { bullet: { kind: "char", char: "•" }, marL: 342900, indent: -342900 },
					runs: [
						{ kind: "r", text: "ab", rPr: {} },
						{ kind: "fld", type: "unknownField", id: "{1}", text: "XYZ", rPr: {} },
						{ kind: "br", rPr: {} },
						{ kind: "r", text: "cd", rPr: {} }
					]
				}
			]
		}
		const map = mapOf(body)
		const text = map.texts[0] ?? ""
		const prefix = text.length - "abXYZ".length - 1 - 2

		expect(prefix).toBeGreaterThan(0)
		// pos 1: the paragraph's start, after the marker.
		expect(map.toLayout(1)).toEqual({ paragraph: 0, offset: prefix })
		expect(map.toLayout(3)).toEqual({ paragraph: 0, offset: prefix + 2 })
		// After the field (one position) its whole text.
		expect(map.toLayout(4)).toEqual({ paragraph: 0, offset: prefix + 5 })
		expect(map.toLayout(5)).toEqual({ paragraph: 0, offset: prefix + 6 })
		expect(map.toLayout(7)).toEqual({ paragraph: 0, offset: prefix + 8 })
		// Back: inside the field goes to its nearer edge; inside the marker to the start.
		expect(map.toDoc(0, prefix + 3)).toBe(3)
		expect(map.toDoc(0, prefix + 4)).toBe(4)
		expect(map.toDoc(0, 0)).toBe(1)
	})

	it("puts carets where the worker's fragments end and finds positions by point", () => {
		const map = mapOf(plain("Hello world", "Second"))
		const start = map.caret(1)
		const end = map.caret(12)
		const second = map.caret(14)

		expect(start?.x).toBeCloseTo(0, 3)
		expect(end?.x ?? 0).toBeGreaterThan(start?.x ?? 0)
		expect(second?.top ?? 0).toBeGreaterThan(start?.top ?? 0)

		// A click at a caret's x on its line finds that position again.
		for (const pos of [1, 4, 7, 12, 14, 18]) {
			const box = map.caret(pos)

			expect(map.posAt(box?.x ?? 0, (box?.top ?? 0) + (box?.height ?? 0) / 2)).toBe(pos)
		}
	})

	it("moves by lines at the goal x, to line edges, and draws a selection box per line", () => {
		const map = mapOf(plain("One", "Two words", "Three"))
		const down = map.lineMove(2, 1, map.caret(2)?.x ?? 0)

		expect(down).toBe(7)
		expect(map.lineMove(1, -1, 0)).toBeUndefined()
		expect(map.lineEdge(8, "end")).toBe(15)
		expect(map.lineEdge(12, "start")).toBe(6)
		expect(map.selection(2, 9)).toHaveLength(2)
		expect(map.selection(4, 4)).toEqual([])
	})

	it("Home from after a trailing space goes to the line's start", () => {
		const map = mapOf(plain("Agenda "))
		const end = 1 + "Agenda ".length

		expect(map.lineEdge(end, "start")).toBe(1)
		expect(map.lineEdge(1, "end")).toBe(end)
	})

	it("starts a wrapped line's caret at the wrap, not at the end of the line before", () => {
		const long = "word ".repeat(40).trim()
		const map = mapOf(plain(long))
		const first = map.caret(1)
		const lines = map.layout.lineCount

		expect(lines).toBeGreaterThan(1)

		const wrapEnd = map.layout.lineInts[3] ?? 0
		const atWrap = map.caret(1 + wrapEnd)

		expect(atWrap?.top ?? 0).toBeGreaterThan(first?.top ?? 0)
		expect(atWrap?.x).toBeCloseTo(0, 3)
	})
})

interface FakeSession {
	readonly api: PresentationSessionApi
	readonly ops: DeckOp[]
	readonly layouts: TextBody[]
	undoSeed: TextSeed | undefined
}

function fakeSession(): FakeSession {
	const ops: DeckOp[] = []
	const layouts: TextBody[] = []
	let revision = 1
	const fake: FakeSession = {
		ops,
		layouts,
		undoSeed: undefined,
		api: {
			layoutText: (_shape: ShapeRef, body: TextBody) => {
				layouts.push(body)

				return Promise.resolve({ ...laid(body), revision })
			},
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ++revision, dirty: true })
			},
			undo: (open?: ShapeRef): Promise<CommandResult> => {
				ops.push({ family: "text", kind: "setAutofitResult", target: open ?? SHAPE })

				return Promise.resolve({
					ok: true,
					revision: ++revision,
					dirty: false,
					...(fake.undoSeed === undefined ? {} : { seed: fake.undoSeed })
				})
			},
			textSeed: () => Promise.resolve(seedOf(plain("x")))
		} as unknown as PresentationSessionApi
	}

	return fake
}

function settle(): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, 0)
	})
}

describe("presentation text editor controller", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("lays out each change and commits one setText after 150 ms idle", async () => {
		vi.useFakeTimers()

		const fake = fakeSession()
		const controller = new TextEditController(fake.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		controller.dispatch(controller.state.tr.insertText("B", 2), true)
		await vi.advanceTimersByTimeAsync(COMMIT_IDLE_MS - 10)

		expect(fake.ops).toEqual([])
		// At most one layout in flight: the second change went after the first answered.
		expect(fake.layouts.length).toBeGreaterThanOrEqual(1)

		await vi.advanceTimersByTimeAsync(20)

		expect(fake.ops).toHaveLength(1)
		expect(fake.ops[0]).toMatchObject({
			family: "text",
			kind: "setText",
			target: SHAPE,
			body: { paragraphs: [{ runs: [{ text: "ABTitle" }] }] }
		})
		expect(fake.layouts.at(-1)?.paragraphs[0]?.runs).toEqual([{ kind: "r", text: "ABTitle", rPr: { sz: 1800 } }])
	})

	it("typing runs share a burst; a formatting change commits the typing first and is a step of its own", async () => {
		const fake = fakeSession()
		const controller = new TextEditController(fake.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("A", 1), true)
		await controller.flush()
		controller.dispatch(controller.state.tr.insertText("B", 2), true)
		controller.setSelection(1, 3)
		controller.run(toggleRunFlag("b"))
		await controller.flush()
		controller.dispatch(controller.state.tr.insertText("C", 8), true)
		await controller.flush()

		const bursts = fake.ops.map(op => (op.family === "text" && op.kind === "setText" ? op.burst : undefined))

		expect(bursts).toHaveLength(4)
		expect(bursts[0]).toBe(bursts[1])
		expect(bursts[2]).not.toBe(bursts[1])
		expect(bursts[3]).not.toBe(bursts[2])
	})

	it("undo in the body sends the pending text first, then the worker's undo with the body open, and reseeds", async () => {
		const fake = fakeSession()
		const controller = new TextEditController(fake.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("New", 1), true)
		fake.undoSeed = seedOf(plain("Title"), 9)

		await controller.step("undo")

		expect(fake.ops.map(op => op.kind)).toEqual(["setText", "setAutofitResult"])
		expect(controller.state.doc.textContent).toBe("Title")
		// The reseeded state is clean: nothing more to send.
		await controller.flush()
		expect(fake.ops).toHaveLength(2)
	})

	it("an undo that did not touch the body leaves the view as it is", async () => {
		const fake = fakeSession()
		const controller = new TextEditController(fake.api, seedOf(plain("Title")), new MeasureCache(new FakeMeasurer()), () => undefined)

		controller.dispatch(controller.state.tr.insertText("X", 1), true)
		await controller.flush()
		await controller.step("undo")
		await settle()

		expect(controller.state.doc.textContent).toBe("XTitle")
	})
})
