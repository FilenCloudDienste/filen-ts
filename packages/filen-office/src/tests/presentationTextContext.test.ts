import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { type ShapeRef, type TextBody } from "../core/presentation/model"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { createEditCapability } from "../dom/presentation/engine/edit"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { layoutShapeText, textSeedOf } from "../dom/presentation/engine/text"
import { presentationTextServices, renderSlideFor } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { body, buildPptx, COLOR_MAP, para, sp, tree, xfrm } from "./pptxFixtures"
import { SOURCE_EMITTER } from "./presentationEditFixtures"

// The text context the editor starts from, read in the worker: a body with nothing visible in it (an empty
// placeholder, a cleared body, a shape without a body) seeds and lays out in its shape's own box; a layer drawn on the
// slide from its layout or master names that layout or master, so a slide shape whose id a master shape repeats seeds
// its own box; a table frame is not one body and refuses.

const EMU = 9525
const INSETS_X = 2 * 91440
const RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

const MASTER =
	tree(
		sp(2, "Title Placeholder 1", 'type="title"', xfrm(457200, 274638, 8229600, 1143000), body("", '<a:bodyPr anchor="ctr"/>')) +
			sp(3, "Text Placeholder 2", 'type="body" idx="1"', xfrm(457200, 1600200, 8229600, 4525963), body("")) +
			sp(7, "Copyright", undefined, `${xfrm(6000000, 6400000, 1900000, 300000)}${RECT}`, body(para("© master text")))
	).replace("<p:cSld>", '<p:cSld name="Office Theme">') + `<p:clrMap ${COLOR_MAP}/>`

const TABLE =
	'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 8"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
	'<p:xfrm><a:off x="100000" y="3000000"/><a:ext cx="2000000" cy="400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
	'<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="1000000"/></a:tblGrid><a:tr h="200000">' +
	"<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>first cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>" +
	"<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>last cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>" +
	"</a:graphicData></a:graphic></p:graphicFrame>"

function deck(): Uint8Array {
	return buildPptx({
		master: MASTER,
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', xfrm(914400, 457200, 7315200, 914400), body("<a:p/>")) +
					sp(3, "Subtitle 2", 'type="body" idx="1"', xfrm(914400, 1828800, 7315200, 1828800)) +
					sp(5, "Words", undefined, `${xfrm(914400, 4114800, 3657600, 914400)}${RECT}`, body(para("Hello World"))) +
					sp(7, "Plain box", undefined, `${xfrm(4572000, 4114800, 2743200, 1371600)}${RECT}`) +
					TABLE
			}
		]
	})
}

interface Harness {
	readonly context: CallContext
	readonly edit: ReturnType<typeof createEditCapability>
	readonly ref: (id: number) => ShapeRef
	close(): void
}

async function harness(): Promise<Harness> {
	const outcome = await openPptxCapability.open({
		source: bytesSource(deck()),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const closers: (() => void)[] = []
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: listener => closers.push(listener)
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "priority",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
	const slide = outcome.deck.slides[0]

	if (slide === undefined) throw new Error("no slide")

	return {
		context,
		edit: createEditCapability({ emit: SOURCE_EMITTER }),
		ref: id => ({ slide, id }),
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

function text(body: TextBody): string[] {
	return body.paragraphs.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
}

function typed(value: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: value, rPr: {} }] }] }
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("presentation text context", () => {
	it("enters an empty placeholder, a placeholder without a body and a shape without one, each in its own box", async () => {
		const h = await harness()

		for (const [id, cx, x] of [
			[2, 7315200, 914400],
			[3, 7315200, 914400],
			[7, 2743200, 4572000]
		] as const) {
			const seed = await textSeedOf(h.context, h.ref(id))

			expect(text(seed.body).join(""), String(id)).toBe("")
			expect(seed.page.page.width, String(id)).toBeCloseTo((cx - INSETS_X) / EMU, 1)
			expect(seed.matrix[4], String(id)).toBeCloseTo((x + 91440) / EMU, 1)

			const laid = await layoutShapeText(h.context.session, h.ref(id), typed("X"), h.context.slicing)

			expect(laid.page.page.sourceTexts.join("").endsWith("X"), String(id)).toBe(true)
		}

		h.close()
	})

	it("seeds a body without paragraphs with the empty line the editor shows, so the caret has a line to sit on", async () => {
		const h = await harness()

		for (const id of [3, 7]) {
			const seed = await textSeedOf(h.context, h.ref(id))

			expect(seed.body.paragraphs, String(id)).toEqual([])
			expect(seed.layout.lineCount, String(id)).toBe(1)
			expect(seed.resolved, String(id)).toHaveLength(1)
		}

		h.close()
	})

	it("lays out typing in a body cleared by the commit before it", async () => {
		const h = await harness()
		const target = h.ref(5)

		expect(
			await h.edit.command(h.context, { family: "text", kind: "setText", target, body: { bodyPr: {}, paragraphs: [] } })
		).toMatchObject({
			ok: true
		})

		const laid = await layoutShapeText(h.context.session, target, typed("X"), h.context.slicing)

		expect(laid.page.page.sourceTexts).toEqual(["X"])
		h.close()
	})

	it("an undo or a redo to an empty body with the body open answers its seed", async () => {
		const h = await harness()
		const target = h.ref(5)

		await h.edit.command(h.context, { family: "text", kind: "setText", target, body: { bodyPr: {}, paragraphs: [] } })

		const undone = await h.edit.undo(h.context, target)

		expect(undone.ok && undone.seed !== undefined && text(undone.seed.body)).toEqual(["Hello World"])

		const redone = await h.edit.redo(h.context, target)

		expect(redone.ok && redone.seed !== undefined && text(redone.seed.body).join("")).toBe("")
		h.close()
	})

	it("a command with the body open answers its seed when it touched that body, and none when it did not", async () => {
		const h = await harness()
		const target = h.ref(5)
		const replaced = await h.edit.command(
			h.context,
			{ family: "text", kind: "replace", query: "World", replacement: "Earth", caseSensitive: false, targets: [{ target }] },
			target
		)

		expect(replaced.ok && replaced.seed !== undefined && text(replaced.seed.body)).toEqual(["Hello Earth"])

		const other = await h.edit.command(h.context, { family: "text", kind: "setText", target: h.ref(2), body: typed("Title") }, target)

		expect(other.ok && other.seed).toBe(undefined)
		h.close()
	})

	it("names a master's layer by the master, so the slide shape with the master shape's id seeds its own box", async () => {
		const h = await harness()
		const session = h.context.session
		const render = await renderSlideFor(h.context, h.ref(7).slide)
		const master = render.layers.filter(layer => layer.role === "master")

		expect(master.length).toBeGreaterThan(0)
		expect(master.every(layer => layer.shape.slide !== h.ref(7).slide)).toBe(true)
		expect(
			render.layers
				.filter(layer => layer.shape.slide === h.ref(7).slide && layer.shape.id === 7)
				.every(layer => layer.role !== "master")
		).toBe(true)

		const seed = await textSeedOf(h.context, h.ref(7))

		expect(seed.page.page.width).toBeCloseTo((2743200 - INSETS_X) / EMU, 1)
		expect(text(seed.body).join("")).toBe("")
		// The master's own render keeps its own ref.
		const masterRef = master[0]?.shape.slide

		expect(masterRef === undefined ? undefined : session.deck.nodes.get(masterRef)?.kind).toBe("master")
		h.close()
	})

	it("refuses a table frame, which holds one body per cell", async () => {
		const h = await harness()

		await expect(textSeedOf(h.context, h.ref(9))).rejects.toMatchObject({ reason: "unsupported" })
		h.close()
	})
})
