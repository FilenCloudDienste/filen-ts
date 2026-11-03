import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { emitOdp, type OdpEmitContext } from "../core/odp/write/emit"
import { emitPptx } from "../core/pptx/write/emit"
import type { PartsApi, PptxEmitContext } from "../core/pptx/write/types"
import { applyOp, opTouches, type ApplyContext } from "../core/presentation/edit/apply"
import type { InkOp, InkStroke } from "../core/presentation/edit/ops"
import { nextShapeId } from "../core/presentation/ids"
import { PATH_LINE, PATH_MOVE, slideRef, type Deck, type ShapeNode, type SlideNode } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { fixtureDeck, FIXTURE_FIRST_SLIDE } from "./fixtures/presentation/deck"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// Ink kept after a slideshow: the op adds one group of freeforms to the slide's tree (and its undo takes it out), the
// pptx writer writes it as a p:grpSp of a:custGeom p:sp's, the ODP writer each stroke as a draw:path, and a corpus
// deck saves with it through the real save pipeline and reads back with the group on its slide.

const SLIDE = slideRef(FIXTURE_FIRST_SLIDE)
const RED = { kind: "srgb", rgb: "ff0000" } as const

function context(deck: Deck): ApplyContext {
	return {
		sourceBytes: () => new Uint8Array(0),
		newShapeId: slide => nextShapeId(deck.nodes.get(slide)?.shapes ?? []),
		newSlideRef: () => slideRef(999)
	}
}

function stroke(points: readonly number[], highlighter = false, width = 28_575): InkStroke {
	return { points: new Float64Array(points), width, color: RED, highlighter }
}

function inkOp(strokes: readonly InkStroke[], slide = SLIDE): InkOp {
	return { family: "ink", kind: "add", slide, strokes, name: "Ink annotations" }
}

function slideOf(deck: Deck, ref = SLIDE): SlideNode {
	const node = deck.nodes.get(ref)

	if (node === undefined) throw new Error("slide not parsed")

	return node
}

function groupNamed(shapes: readonly ShapeNode[], name: string): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.kind === "grpSp" && shape.name === name) return shape

		const inner = shape.children === undefined ? undefined : groupNamed(shape.children, name)

		if (inner !== undefined) return inner
	}

	return undefined
}

const PARTS: PartsApi = {
	owner: "/ppt/slides/slide1.xml",
	addPart: () => ({ part: "/ppt/media/image9.png", rId: "rId9" }),
	relate: () => "rId1",
	target: () => undefined,
	removePart: () => undefined,
	editor: () => {
		throw new Error("no editor here")
	}
}

function odpContext(deck: Deck, styles: string[]): OdpEmitContext {
	return {
		deck,
		document: undefined,
		editor: undefined,
		styles: {
			automatic: (family, properties) => {
				styles.push(`${family}:${properties}`)

				return `gr${String(styles.length)}`
			},
			addEntry: path => path
		}
	}
}

function markupOf(result: ReturnType<typeof emitPptx>): string {
	if (result.kind !== "markup") throw new Error(JSON.stringify(result))

	return result.pieces.map(piece => (typeof piece === "string" ? piece : "")).join("")
}

describe("applying kept ink", () => {
	it("adds one group named as the op says, one freeform per stroke with no fill and a round line of the stroke's width and colour", () => {
		const deck = fixtureDeck()
		const before = slideOf(deck).shapes.length
		const result = applyOp(
			deck,
			inkOp([stroke([100_000, 200_000, 500_000, 260_000, 900_000.4, 800_000]), stroke([300_000, 300_000, 400_000, 100_000], true)]),
			context(deck)
		)

		expect(result.kind).toBe("applied")

		const shapes = slideOf(deck).shapes

		expect(shapes).toHaveLength(before + 1)

		const group = shapes[shapes.length - 1] as ShapeNode

		expect(group).toMatchObject({ kind: "grpSp", name: "Ink annotations", hidden: false })
		expect(result.kind === "applied" && result.op.family === "ink" ? result.op.id : undefined).toBe(group.id)
		// The union of the strokes' boxes, its child space its own box.
		expect(group.xfrm).toEqual({
			x: 100_000,
			y: 100_000,
			cx: 800_000,
			cy: 700_000,
			rot: 0,
			flipH: false,
			flipV: false,
			chX: 100_000,
			chY: 100_000,
			chCx: 800_000,
			chCy: 700_000
		})

		const [pen, highlighter] = group.children ?? []

		// Each stroke is marked as kept ink: the ink family writes it (ODF: a draw:path), not the shape family.
		expect([pen?.ink, highlighter?.ink]).toEqual([true, true])

		expect(pen?.xfrm).toEqual({ x: 100_000, y: 200_000, cx: 800_000, cy: 600_000, rot: 0, flipH: false, flipV: false })
		expect(pen?.props?.fill).toBe("none")
		expect(pen?.props?.ln).toEqual({
			w: 28_575,
			fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } },
			cap: "rnd",
			join: "round"
		})

		const geometry = pen?.props?.geometry

		if (geometry?.kind !== "custom") throw new Error("no custom outline")

		const path = geometry.paths[0]

		expect(geometry.paths).toHaveLength(1)
		expect(path).toMatchObject({ w: 800_000, h: 600_000, stroke: true })
		expect([...(path?.commands ?? [])]).toEqual([PATH_MOVE, PATH_LINE, PATH_LINE])
		// Relative to the stroke's box, whole EMU.
		expect([...(path?.coords ?? [])]).toEqual([0, 0, 400_000, 60_000, 800_000, 600_000])
		expect(path?.coords).toBeInstanceOf(Float64Array)

		// A highlighter is the same freeform at half opacity.
		expect(highlighter?.props?.ln).toEqual({
			w: 28_575,
			fill: { kind: "solid", color: { kind: "srgb", rgb: "FF0000", mods: [{ name: "alpha", value: 50_000 }] } },
			cap: "rnd",
			join: "round"
		})

		const ids = [group.id, ...(group.children ?? []).map(child => child.id)]

		expect(new Set(ids).size).toBe(3)
		expect(
			ids.every(
				id =>
					!slideOf(deck)
						.shapes.slice(0, before)
						.some(shape => shape.id === id)
			)
		).toBe(true)
	})

	it("makes a stroke that never left its point a dot: a line of 0.1 mm across the middle of a 0.1 mm box centred on it, drawn by its round caps", () => {
		for (const points of [
			[5000, 6000],
			[5000, 6000, 5000.2, 5999.8, 5000, 6000]
		]) {
			const deck = fixtureDeck()

			expect(applyOp(deck, inkOp([stroke(points)]), context(deck)).kind).toBe("applied")

			const dot = groupNamed(slideOf(deck).shapes, "Ink annotations")?.children?.[0]
			const geometry = dot?.props?.geometry

			expect(dot?.xfrm).toEqual({ x: 3200, y: 4200, cx: 3600, cy: 3600, rot: 0, flipH: false, flipV: false })
			expect(geometry?.kind === "custom" ? geometry.paths[0] : undefined).toMatchObject({ w: 3600, h: 3600 })
			expect(geometry?.kind === "custom" ? [...geometry.paths[0]!.commands] : []).toEqual([PATH_MOVE, PATH_LINE])
			expect(geometry?.kind === "custom" ? [...geometry.paths[0]!.coords] : []).toEqual([0, 1800, 3600, 1800])
		}
	})

	it("keeps a straight stroke along an axis centred in a box of at least 0.1 mm across it", () => {
		const deck = fixtureDeck()

		expect(applyOp(deck, inkOp([stroke([1_000_000, 500_000, 2_000_000, 500_000])]), context(deck)).kind).toBe("applied")

		const line = groupNamed(slideOf(deck).shapes, "Ink annotations")?.children?.[0]
		const geometry = line?.props?.geometry

		expect(line?.xfrm).toMatchObject({ x: 1_000_000, y: 498_200, cx: 1_000_000, cy: 3600 })
		expect(geometry?.kind === "custom" ? [...geometry.paths[0]!.coords] : []).toEqual([0, 1800, 1_000_000, 1800])
	})

	it("is undone by deleting the group, and redone with the same ids", () => {
		const deck = fixtureDeck()
		const shapesBefore = structuredClone(slideOf(deck).shapes)
		const op = inkOp([stroke([0, 0, 100, 100]), stroke([50, 50, 60, 70])])
		const first = applyOp(deck, op, context(deck))

		if (first.kind !== "applied" || first.op.family !== "ink") throw new Error("not applied")

		const made = structuredClone(groupNamed(slideOf(deck).shapes, "Ink annotations"))

		expect(first.inverse.ops).toEqual([{ family: "shape", kind: "delete", slide: SLIDE, shapes: [first.op.id] }])
		expect(opTouches(first.op)).toEqual([{ kind: "shape", slide: SLIDE, shape: first.op.id, dirt: { kind: "node" } }])

		for (const back of first.inverse.ops) expect(applyOp(deck, back, context(deck)).kind).toBe("applied")

		expect(slideOf(deck).shapes).toEqual(shapesBefore)

		expect(applyOp(deck, first.op, context(deck)).kind).toBe("applied")
		expect(groupNamed(slideOf(deck).shapes, "Ink annotations")).toEqual(made)
	})

	it("refuses with a typed reason what the deck cannot carry, leaving the slide as it was", () => {
		const cases: [InkOp, string][] = [
			[inkOp([]), "malformed"],
			[inkOp([stroke([1, 2, 3])]), "malformed"],
			[inkOp([stroke([1, Number.NaN])]), "malformed"],
			[inkOp([stroke([1, 2], false, 0)]), "malformed"],
			[{ ...inkOp([stroke([1, 2])]), name: "Ink\u0001" }, "malformed"],
			[inkOp([stroke(new Array<number>(200_002).fill(1))]), "tooLarge"],
			[inkOp([stroke([1, 2])], slideRef(4242)), "notFound"]
		]

		for (const [op, reason] of cases) {
			const deck = fixtureDeck()
			const before = structuredClone(slideOf(deck))

			expect(applyOp(deck, op, context(deck)), reason).toMatchObject({ kind: "refused", reason })
			expect(slideOf(deck)).toEqual(before)
		}

		const odp = { ...fixtureDeck(), format: "odp" } as Deck

		expect(applyOp(odp, inkOp([{ ...stroke([1, 2]), color: { kind: "scheme", slot: "accent1" } }]), context(odp))).toMatchObject({
			kind: "refused",
			reason: "unsupported"
		})
	})

	it("refuses ink past the slide's ink point budget, earlier kept ink counted", () => {
		const deck = fixtureDeck()
		const many = new Array<number>(2 * 100_000).fill(0).map((_, k) => k)
		const strokes = Array.from({ length: 10 }, () => stroke(many))

		expect(applyOp(deck, inkOp(strokes), context(deck)).kind).toBe("applied")
		expect(applyOp(deck, inkOp([stroke([1, 2])]), context(deck))).toMatchObject({ kind: "refused", reason: "tooLarge" })
	})
})

describe("writing kept ink", () => {
	function applied(): { deck: Deck; group: ShapeNode } {
		const deck = fixtureDeck()

		applyOp(
			deck,
			inkOp([stroke([100_000, 200_000, 500_000, 260_000, 900_000, 800_000]), stroke([300_000, 300_000], true)]),
			context(deck)
		)

		const group = groupNamed(slideOf(deck).shapes, "Ink annotations")

		if (group === undefined) throw new Error("no group")

		return { deck, group }
	}

	it("writes PresentationML: a p:grpSp with its box and child space, each stroke an a:custGeom p:sp with a:noFill and a round a:ln", () => {
		const { deck, group } = applied()
		const pptx: PptxEmitContext = { deck, document: undefined, parts: PARTS }
		const touch = { kind: "shape", slide: SLIDE, shape: group.id, dirt: { kind: "node" } } as const
		const markup = markupOf(emitPptx("shape", { slide: slideOf(deck), shape: group, touch }, pptx))

		expect(markup).toMatch(
			new RegExp(
				`^<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${String(group.id)}" name="Ink annotations"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
					'<p:grpSpPr><a:xfrm><a:off x="100000" y="200000"/><a:ext cx="800000" cy="600000"/><a:chOff x="100000" y="200000"/><a:chExt cx="800000" cy="600000"/></a:xfrm></p:grpSpPr><p:sp>',
				"u"
			)
		)

		const pen = group.children?.[0] as ShapeNode
		const sp = markupOf(emitPptx("ink", { slide: slideOf(deck), shape: pen, touch: { ...touch, shape: pen.id } }, pptx))

		expect(sp).toContain(`<p:cNvPr id="${String(pen.id)}" name="Ink annotations 1"/>`)
		expect(sp).toContain(
			'<a:custGeom><a:avLst/><a:gdLst></a:gdLst><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="800000" h="600000" fill="norm" stroke="1" extrusionOk="0">' +
				'<a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="400000" y="60000"/></a:lnTo><a:lnTo><a:pt x="800000" y="600000"/></a:lnTo></a:path></a:pathLst></a:custGeom>'
		)
		expect(sp).toContain('<a:noFill/><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill><a:round/></a:ln>')
		expect(markup).toContain(sp)
		expect(markup).toContain('<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>')
		expect(markup.endsWith("</p:sp></p:grpSp>")).toBe(true)
	})

	it("writes ODF: each stroke a draw:path in its view box with a graphic style of no fill and a round stroke", () => {
		const { deck, group } = applied()
		const styles: string[] = []
		const [pen, dot] = group.children as [ShapeNode, ShapeNode]
		const touch = { kind: "shape", slide: SLIDE, shape: pen.id, dirt: { kind: "node" } } as const
		const path = markupOf(emitOdp("ink", { slide: slideOf(deck), shape: pen, touch }, odpContext(deck, styles)))

		expect(path).toBe(
			'<draw:path draw:name="Ink annotations 1" draw:style-name="gr1" svg:x="0.277778cm" svg:y="0.555556cm" svg:width="2.222222cm" svg:height="1.666667cm"' +
				' svg:viewBox="0 0 800000 600000" svg:d="M0 0L400000 60000 800000 600000"></draw:path>'
		)
		expect(styles[0]).toBe(
			'graphic:<style:graphic-properties draw:fill="none" draw:stroke="solid" svg:stroke-width="0.079375cm" svg:stroke-color="#ff0000" svg:stroke-opacity="100%"' +
				' svg:stroke-linecap="round" draw:stroke-linejoin="round"/>'
		)

		const dotPath = markupOf(
			emitOdp("ink", { slide: slideOf(deck), shape: dot, touch: { ...touch, shape: dot.id } }, odpContext(deck, styles))
		)

		expect(dotPath).toContain('svg:viewBox="0 0 3600 3600" svg:d="M0 1800L3600 1800"')
		expect(styles[1]).toContain('svg:stroke-opacity="50%"')
	})

	it("places an ODF stroke where a moved group puts it (a draw:g has no box of its own)", () => {
		const { deck, group } = applied()
		const pen = group.children?.[0] as ShapeNode

		group.xfrm = { ...group.xfrm!, x: group.xfrm!.x + 360_000 }

		const touch = { kind: "shape", slide: SLIDE, shape: pen.id, dirt: { kind: "node" } } as const
		const path = markupOf(emitOdp("ink", { slide: slideOf(deck), shape: pen, touch }, odpContext(deck, [])))

		expect(path).toContain('svg:x="1.277778cm"')
	})

	it("refuses, never drops, a freeform ODF would read back as another outline", () => {
		const { deck, group } = applied()
		const pen = group.children?.[0] as ShapeNode
		const geometry = pen.props?.geometry

		if (geometry?.kind !== "custom") throw new Error("no outline")

		const touch = { kind: "shape", slide: SLIDE, shape: pen.id, dirt: { kind: "node" } } as const
		const variants: ShapeNode[] = [
			{
				...pen,
				props: { ...pen.props, geometry: { ...geometry, paths: [{ ...geometry.paths[0]!, commands: new Uint8Array([0, 4, 1]) }] } }
			},
			{ ...pen, props: { ...pen.props, geometry: { ...geometry, paths: [geometry.paths[0]!, geometry.paths[0]!] } } },
			{ ...pen, props: { ...pen.props, geometry: { ...geometry, paths: [{ ...geometry.paths[0]!, fill: "none" }] } } },
			{ ...pen, props: { ...pen.props, ln: { w: 100, fill: { kind: "solid", color: { kind: "scheme", slot: "accent1" } } } } },
			{ ...pen, xfrm: { ...pen.xfrm!, flipH: true } }
		]

		for (const shape of variants)
			expect(emitOdp("ink", { slide: slideOf(deck), shape, touch }, odpContext(deck, []))).toMatchObject({ kind: "refused" })
	})
})

const PPTX_DECK = join(CORPUS_DIR, "pptx", "govuk__CCG_standard_slide_set.pptx")

describe.skipIf(!existsSync(PPTX_DECK))("saving kept ink in a corpus pptx", () => {
	it(
		"saves the group on its slide through the save pipeline, reads it back, undoes to unchanged and saves again the same",
		{ timeout: 120_000 },
		async () => {
			const h = await driveSession(new Uint8Array(readFileSync(PPTX_DECK)), "pptx")
			const ref = h.session.deck.slides[1]!
			const op = inkOp(
				[stroke([1_000_000, 1_000_000, 2_000_000, 1_500_000, 3_000_000, 1_200_000]), stroke([2_500_000, 2_500_000], true)],
				ref
			)

			expect(await h.command(op)).toMatchObject({ ok: true })
			expect(await h.undo()).toMatchObject({ ok: true })
			expect((await h.save()).result.kind).toBe("unchanged")
			expect(await h.redo()).toMatchObject({ ok: true })

			const saved = await h.save()

			expect(saved.result.kind).toBe("written")

			const entries = await entriesOf(saved.bytes!)
			const names = [...entries.keys()].filter(name => /^ppt\/slides\/slide\d+\.xml$/u.test(name))
			const written = names.map(name => text(entries.get(name))).filter(xml => xml.includes('name="Ink annotations"'))

			expect(written).toHaveLength(1)
			expect(written[0]).toMatch(/<p:grpSp><p:nvGrpSpPr><p:cNvPr id="\d+" name="Ink annotations"\/>/u)
			expect(written[0]?.match(/<a:custGeom>/gu)).toHaveLength(2)

			const back = await driveSession(saved.bytes!, "pptx")
			const node = await pptxParts(back.session.deck)?.slide(back.session.deck.slides[1]!)
			const group = groupNamed(node?.shapes ?? [], "Ink annotations")

			expect(group?.children?.map(child => child.props?.geometry?.kind ?? child.kind)).toHaveLength(2)

			// Nothing changed since: no upload. An edit on another slide leaves the ink's slide as written.
			expect((await h.save()).result.kind).toBe("unchanged")

			const other = await pptxParts(h.session.deck)?.slide(h.session.deck.slides[0]!)
			const first = other?.shapes[0]

			expect(first).toBeDefined()
			expect(
				await h.command({ family: "shape", kind: "setAlt", target: { slide: other!.ref, id: first!.id }, alt: { descr: "Edited" } })
			).toMatchObject({ ok: true })

			const again = await h.save()

			expect(again.result.kind).toBe("written")

			const later = await entriesOf(again.bytes!)

			for (const name of names)
				if (text(entries.get(name)).includes('name="Ink annotations"')) expect(text(later.get(name))).toBe(text(entries.get(name)))
		}
	)
})

const ODP_DECK = join(CORPUS_DIR, "odp", "govuk__Workshop_in_a_box_slides_ODP.odp")

describe.skipIf(!existsSync(ODP_DECK))("saving kept ink in a corpus ODP deck", () => {
	it("writes each stroke as a draw:path in a draw:g, reads it back, and the next save is unchanged", { timeout: 120_000 }, async () => {
		const h = await driveSession(new Uint8Array(readFileSync(ODP_DECK)), "odp")
		const ref = h.session.deck.slides[1]!

		await odpParts(h.session.deck)?.slide(ref)
		expect(
			await h.command(
				inkOp(
					[stroke([1_000_000, 1_000_000, 2_000_000, 1_500_000, 3_000_000, 1_200_000]), stroke([2_500_000, 2_500_000], true)],
					ref
				)
			)
		).toMatchObject({ ok: true })

		const saved = await h.save()

		expect(saved.result.kind).toBe("written")

		const content = text((await entriesOf(saved.bytes!)).get("content.xml"))
		const group = /<draw:g\b[^>]*draw:name="Ink annotations"[\s\S]*?<\/draw:g>/u.exec(content)?.[0] ?? ""

		expect(group.match(/<draw:path /gu)).toHaveLength(2)
		expect(group).toContain('svg:d="M0 0L1000000 500000 2000000 200000"')

		const back = await driveSession(saved.bytes!, "odp")
		const node = await odpParts(back.session.deck)?.slide(back.session.deck.slides[1]!)

		expect(groupNamed(node?.shapes ?? [], "Ink annotations")?.children).toHaveLength(2)
		expect((await h.save()).result.kind).toBe("unchanged")
	})
})
