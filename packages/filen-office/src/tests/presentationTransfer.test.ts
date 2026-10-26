import { describe, expect, it } from "vitest"
import { PATH_LINE, PATH_MOVE, slideRef, type CustomPath, type ShapeNode, type TextBody } from "../core/presentation/model"
import type { DeckOp } from "../core/presentation/edit/ops"
import { transferablesOf, type FromPresentationWorker, type ToPresentationWorker } from "../dom/presentation/protocol"
import { fixtureBody, fixtureDeck } from "./fixtures/presentation/deck"
import { fixtureSlideRender } from "./fixtures/presentation/slideRender"
import { fixtureTextLayout, fixtureTextPage } from "./fixtures/presentation/textPage"

// What a presentation message gives up when it is posted: output arrays (drawing and text data, find results, inserted
// bytes, ports, bitmaps) are transferred; model values (bodies, shapes, ink, timing) are cloned, so the sender's live
// model and retained values stay attached.

function post<T>(message: T & (ToPresentationWorker | FromPresentationWorker)): T {
	const options = { transfer: transferablesOf(message) } as unknown as Parameters<typeof structuredClone>[1]

	return structuredClone(message, options)
}

function dashedBody(): { readonly body: TextBody; readonly dash: Float64Array } {
	const dash = new Float64Array([3, 1])
	const body = fixtureBody(["Dashed"])
	const paragraph = body.paragraphs[0]

	if (paragraph === undefined) throw new Error("no paragraph")

	paragraph.runs = [{ kind: "r", text: "Dashed", rPr: { ln: { w: 12_700, custDash: dash } } }]

	return { body, dash }
}

function freeform(): { readonly shape: ShapeNode; readonly path: CustomPath } {
	const path: CustomPath = {
		w: 100,
		h: 100,
		fill: "none",
		stroke: true,
		extrusionOk: false,
		commands: new Uint8Array([PATH_MOVE, PATH_LINE]),
		coords: new Float64Array([0, 0, 100, 100])
	}

	return {
		shape: {
			id: 20,
			name: "Freeform 19",
			hidden: false,
			kind: "sp",
			props: { geometry: { kind: "custom", guides: [], paths: [path] } }
		},
		path
	}
}

const target = { slide: slideRef(10), id: 2 }

describe("presentation transfer rule", () => {
	it("keeps a sent TextSeed's body attached, transferring only its page and layout", () => {
		const { body, dash } = dashedBody()
		const page = fixtureTextPage(["Dashed"])
		const layout = fixtureTextLayout(["Dashed"])

		post({
			t: "result",
			s: 1,
			id: 1,
			method: "textSeed",
			value: { shape: target, revision: 1, body, resolved: [], page, layout, matrix: [1, 0, 0, 1, 0, 0] }
		})

		expect(dash.byteLength).toBe(16)
		expect(page.page.lineInts.byteLength).toBe(0)
		expect(layout.styleFloats.byteLength).toBe(0)
	})

	it("keeps the model values of setText, insert and ink ops attached on the page", () => {
		const { body, dash } = dashedBody()
		const { shape, path } = freeform()
		const points = new Float64Array([0, 0, 9525, 9525])
		const ops: DeckOp[] = [
			{ family: "text", kind: "setText", target, body },
			{ family: "shape", kind: "insert", slide: target.slide, shape },
			{
				family: "ink",
				kind: "add",
				slide: target.slide,
				strokes: [{ points, width: 9525, color: { kind: "srgb", rgb: "000000" }, highlighter: false }],
				name: "Ink"
			}
		]

		for (const [id, op] of ops.entries()) post({ t: "call", s: 1, id, method: "command", args: [op] })

		expect([dash.byteLength, path.coords.byteLength, path.commands.byteLength, points.byteLength]).toEqual([16, 32, 2, 32])
	})

	it("transfers an inserted picture's bytes and a workbook, which the page no longer needs", () => {
		const image = new Uint8Array(64)
		const workbook = new Uint8Array(32)

		post({
			t: "call",
			s: 1,
			id: 1,
			method: "command",
			args: [
				{
					family: "picture",
					kind: "insert",
					slide: target.slide,
					shape: freeform().shape,
					image: { bytes: image, contentType: "image/png", width: 8, height: 8 }
				}
			]
		})
		post({
			t: "call",
			s: 1,
			id: 2,
			method: "command",
			args: [
				{
					family: "chart",
					kind: "setWorkbook",
					target,
					workbook,
					contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				}
			]
		})

		expect([image.byteLength, workbook.byteLength]).toEqual([0, 0])
	})

	it("transfers rendered slides and find results, and the deck's bytes on open", () => {
		const render = fixtureSlideRender(fixtureDeck(), 0)
		const found = new Int32Array(6)
		const bytes = new Uint8Array(22)

		post({ t: "event", s: 1, event: { type: "slides", renders: [render], final: true } })
		post({ t: "result", s: 1, id: 3, method: "find", value: found })
		post({ t: "open", s: 1, source: { kind: "bytes", bytes }, options: { format: "pptx", fileName: "Deck.pptx" } })

		expect(render.background.commands.byteLength).toBe(0)
		expect(render.layers[0]?.text?.page.fragmentInts.byteLength).toBe(0)
		expect([found.byteLength, bytes.byteLength]).toEqual([0, 0])
	})
})
