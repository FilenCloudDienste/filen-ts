import { describe, expect, it } from "vitest"
import { EditorState, TextSelection } from "prosemirror-state"
import { rgba } from "../core/drawingml/index"
import { FontManager } from "../core/fonts/index"
import type { Paragraph, TextBody } from "../core/presentation/model"
import { fontRequests, layoutBody, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { bodyToDoc, docToBody, presentationTextSchema } from "../core/presentation/text/schema"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import { LayoutMap } from "../react/presentation/edit/text/layoutMap"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { budget, cpuMs } from "./timing"

// One keystroke in a 30-paragraph body, both sides of the editor's path: the page's share (the transaction, the
// body sent, the layout map over the answer, the caret and a selection) and the worker's layoutText (resolve, lay
// out, the transferable copy). The page's p95 over 60 keystrokes, the worker's least of 20; widths from the
// bundled faces' hmtx tables, the measuring caches warm as they are while typing.

const SENTENCE = "The quick brown fox jumps over the lazy dog while the slide keeps its layout steady"

function body(): TextBody {
	const paragraph = (k: number): Paragraph => ({
		pPr: { marL: 342900, indent: -342900, bullet: { kind: "char", char: "•" } },
		runs: [
			{ kind: "r", text: `${SENTENCE} ${String(k)}`, rPr: { sz: 1800 } },
			{ kind: "r", text: " with a bold tail", rPr: { sz: 1800, b: true } }
		]
	})

	return { bodyPr: {}, paragraphs: Array.from({ length: 30 }, (_, k) => paragraph(k)) }
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}

describe("presentationTextEditPerf", () => {
	it("a keystroke costs the page at most 8 ms p95 and the worker at most 4 ms", { timeout: budget(60_000) }, async ({ task }) => {
		const fonts = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fotest")
		const environment: TextEnvironment = { fonts, cache: new MeasureCache(new HmtxMeasurer()) }
		const context: BodyContext = {
			listStyles: [],
			bodyPr: [],
			fonts: { color: () => rgba("000000"), typeface: typeface => (typeface.startsWith("+") ? "Calibri" : typeface) }
		}
		const box = { width: 900, height: 600 }
		const seed = body()
		const { doc, origins } = bodyToDoc(seed)
		const pageCache = new MeasureCache(new HmtxMeasurer())

		await fonts.prepare(fontRequests(resolveBody(seed, context)))

		let state = EditorState.create({ doc, schema: presentationTextSchema })
		// The caret in paragraph 16, mid-sentence.
		let caret = 1

		for (let p = 0; p < 15; p++) caret += (doc.child(p).content.size ?? 0) + 2

		caret += 20
		state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, caret)))

		let laid = transferableLayout(layoutBody(resolveBody(seed, context), box, environment))
		let map = new LayoutMap(state.doc, seed, laid, pageCache)
		const page: number[] = []
		let worker = Number.POSITIVE_INFINITY

		for (let key = 0; key < 60; key++) {
			const start = cpuMs()

			state = state.apply(state.tr.insertText("x"))

			const sent = docToBody(state.doc, seed, origins)
			const sentAt = cpuMs()
			const workerStart = cpuMs()

			laid = transferableLayout(layoutBody(resolveBody(sent, context), box, environment))
			worker = Math.min(worker, cpuMs() - workerStart)

			const answered = cpuMs()

			map = new LayoutMap(state.doc, sent, laid, pageCache)
			map.caret(state.selection.head)
			map.selection(state.selection.head - 10, state.selection.head)
			page.push(sentAt - start + (cpuMs() - answered))
		}

		const p95 = percentile(page, 0.95)

		Object.assign(task.meta, {
			perf: {
				presentationTextEditPageP95CpuMs: { value: p95, budget: 8 },
				presentationTextEditWorkerCpuMs: { value: worker, budget: 4 }
			}
		})
		expect(map.paragraphCount).toBe(30)
		expect(p95).toBeLessThanOrEqual(budget(8))
		expect(worker).toBeLessThanOrEqual(budget(4))
	})
})
