import { describe, expect, it } from "vitest"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { paragraphSpans, slideTiming, type PptAnimContext, type PptAnimShape, type PptLegacyBuild } from "../core/ppt/anim"
import { recordAt, RecordCounter } from "../core/ppt/records"
import type { TextBlock } from "../core/ppt/text"
import { readTiming } from "../core/pptx/read/timing"
import { partReader } from "../core/pptx/read/xml"
import { parseXml } from "../core/xml/index"
import { bytesSource } from "../core/opc/index"
import { pptToPptx } from "../core/ppt/toPptx"
import { buildPpt, concat, container, record } from "./pptFixtures"

// A slide's animations ([MS-PPT] §2.8) to p:timing (ECMA-376 Part 1 §19.5), read back with the pptx timing reader.

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4)

	new DataView(out.buffer).setUint32(0, value >>> 0, true)

	return out
}

function f32(value: number): Uint8Array {
	const out = new Uint8Array(4)

	new DataView(out.buffer).setFloat32(0, value, true)

	return out
}

function utf16(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2 + 2)

	for (let k = 0; k < text.length; k++) out[2 * k] = text.charCodeAt(k)

	return out
}

const int = (id: number, value: number): Uint8Array => record(0xf142, concat(Uint8Array.of(1), u32(value)), id)
const str = (instance: number, value: string): Uint8Array => record(0xf142, concat(Uint8Array.of(3), utf16(value)), instance)
const properties = (...items: Uint8Array[]): Uint8Array => container(0xf13d, items)

// TimeNodeAtom: type (0 par, 1 seq, 3 behaviour, 4 media), fill and duration when given.
function nodeAtom(type: number, options: { fill?: number; dur?: number; restart?: number } = {}): Uint8Array {
	const flags =
		0x8 | (options.fill === undefined ? 0 : 0x1) | (options.dur === undefined ? 0 : 0x10) | (options.restart === undefined ? 0 : 0x2)

	return record(
		0xf127,
		concat(u32(0), u32(options.restart ?? 0), u32(type), u32(options.fill ?? 0), u32(0), u32(0), u32(options.dur ?? 0), u32(flags))
	)
}

function condition(instance: number, object: number, event: number, delay: number, target?: Uint8Array): Uint8Array {
	return container(
		0xf125,
		[record(0xf128, concat(u32(object), u32(event), u32(0), u32(delay))), ...(target === undefined ? [] : [target])],
		instance
	)
}

const pageTarget = (): Uint8Array => container(0xf13c, [record(0x2b01, u32(1))])
const shapeTarget = (spid: number, type = 0, start = 0, end = 0): Uint8Array =>
	container(0xf13c, [record(0x2afb, concat(u32(type), u32(1), u32(spid), u32(start), u32(end)))])

function behavior(target: Uint8Array, attribute?: string): Uint8Array {
	return container(0xf12a, [
		record(0xf133, concat(u32(attribute === undefined ? 0 : 0x4), u32(0), u32(0), u32(0))),
		...(attribute === undefined ? [] : [container(0xf13e, [str(0, attribute)], 1)]),
		target
	])
}

const node = (...children: Uint8Array[]): Uint8Array => container(0xf144, children, 1)

// The PowerPoint 2002 tree of one click that shows shape 5 and fades it in, its builds, and a slide holding it.
function treeSlide(effect: Uint8Array[], extra: readonly Uint8Array[] = []): Uint8Array {
	const tree = node(
		nodeAtom(0, { dur: -1, restart: 3 }),
		properties(int(20, 9)),
		node(
			nodeAtom(1, { dur: -1 }),
			properties(int(20, 4)),
			record(0xf141, concat(u32(1), u32(1), u32(0), u32(0), u32(0x3))),
			condition(3, 1, 9, 0, pageTarget()),
			condition(4, 1, 10, 0, pageTarget()),
			node(nodeAtom(0, { fill: 0 }), condition(1, 0, 0, -1), node(nodeAtom(0, { fill: 0 }), condition(1, 0, 0, 0), node(...effect)))
		)
	)
	const blob = record(0x138b, concat(tree, ...extra), 0, 0)
	const tag = container(0x138a, [record(0x0fba, utf16("___PPT10").subarray(0, 16)), blob])

	return container(0x03ee, [container(0x1388, [tag])])
}

function fadeIn(spid: number, target = shapeTarget(spid)): Uint8Array[] {
	return [
		nodeAtom(0, { fill: 0 }),
		properties(int(20, 1), int(9, 10), int(10, 0), int(11, 1), int(19, 0)),
		condition(1, 0, 0, 0),
		node(
			nodeAtom(3, { fill: 0, dur: 1 }),
			container(0xf131, [record(0xf13a, concat(u32(0x1), u32(1))), str(1, "visible"), behavior(target, "style.visibility")]),
			condition(1, 0, 0, 0)
		),
		node(nodeAtom(3, { dur: 500 }), container(0xf12d, [record(0xf136, concat(u32(0x3), u32(0))), str(1, "fade"), behavior(target)]))
	]
}

function contextOf(
	data: Uint8Array,
	shapes: ReadonlyMap<number, PptAnimShape>,
	budgets = DEFAULT_PRESENTATION_BUDGETS.timing
): PptAnimContext {
	return {
		data,
		counter: new RecordCounter(),
		shapes,
		sound: id => (id === 3 ? { rId: "rId7", name: "chime" } : undefined),
		embeddedSound: () => undefined,
		scheme: [0xffffff, 0, 0x808080, 0, 0x99cc00, 0xcc3333, 0xffcccc, 0xb2b2b2],
		budgets
	}
}

function timingOf(xml: string): ReturnType<typeof readTiming> {
	const document = parseXml(
		new TextEncoder().encode(
			`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${xml}</p:sld>`
		)
	)

	return readTiming(
		{ reader: partReader(document), part: "/ppt/slides/slide1.xml", epoch: 0, budgets: DEFAULT_PRESENTATION_BUDGETS.timing },
		document.documentElement()
	)
}

const SHAPE5: ReadonlyMap<number, PptAnimShape> = new Map([[5, { paragraphs: [] }]])

describe("ppt time trees", () => {
	it("writes the tree node for node, the ids in document order", () => {
		const slide = treeSlide(fadeIn(5))
		const timing = slideTiming(recordAt(slide, 0), [], contextOf(slide, SHAPE5))

		expect(timing.lost).toBe(false)
		expect(timing.xml).toContain('<p:cTn id="1" restart="never" dur="indefinite" nodeType="tmRoot">')
		expect(timing.xml).toContain('<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">')
		expect(timing.xml).toContain(
			'<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
		)
		expect(timing.xml).toContain(
			'<p:cTn id="5" fill="hold" presetID="10" presetClass="entr" presetSubtype="0" grpId="0" nodeType="clickEffect">'
		)
		expect(timing.xml).toContain(
			'<p:set><p:cBhvr><p:cTn id="6" fill="hold" dur="1"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="5"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>'
		)
		expect(timing.xml).toContain(
			'<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="500"></p:cTn><p:tgtEl><p:spTgt spid="5"/>'
		)

		const tree = timingOf(timing.xml)
		const effect = tree?.root.ctn.children[0]?.ctn.children[0]?.ctn.children[0]?.ctn.children[0]

		expect(effect?.ctn).toMatchObject({ presetID: 10, presetClass: "entr", nodeType: "clickEffect", grpId: 0 })
		expect(effect?.ctn.children.map(child => (child.kind === "behavior" ? child.behavior.type : child.kind))).toEqual([
			"set",
			"animEffect"
		])
	})

	it("targets whole paragraphs of a text range as a paragraph range, others as characters", () => {
		const shapes = new Map([
			[
				5,
				{
					paragraphs: [
						{ start: 0, end: 4, level: 0 },
						{ start: 5, end: 9, level: 1 },
						{ start: 10, end: 14, level: 0 }
					]
				}
			]
		])
		const slide = treeSlide(fadeIn(5, shapeTarget(5, 2, 5, 15)))
		const partial = treeSlide(fadeIn(5, shapeTarget(5, 2, 6, 8)))

		expect(slideTiming(recordAt(slide, 0), [], contextOf(slide, shapes)).xml).toContain(
			'<p:spTgt spid="5"><p:txEl><p:pRg st="1" end="2"/></p:txEl></p:spTgt>'
		)
		expect(slideTiming(recordAt(partial, 0), [], contextOf(partial, shapes)).xml).toContain(
			'<p:spTgt spid="5"><p:txEl><p:charRg st="6" end="8"/></p:txEl></p:spTgt>'
		)
	})

	it("reads time modifiers as floats: FLT_MAX repeats forever", () => {
		const effect = fadeIn(5)
		const slide = treeSlide([
			...effect,
			record(0xf129, concat(u32(0), new Uint8Array([0xff, 0xff, 0x7f, 0x7f]))),
			record(0xf129, concat(u32(4), f32(1))),
			record(0xf129, concat(u32(5), f32(1)))
		])
		const xml = slideTiming(recordAt(slide, 0), [], contextOf(slide, SHAPE5)).xml

		expect(xml).toContain('repeatCount="indefinite" decel="100000" autoRev="1"')
		expect(timingOf(xml)?.root.ctn.children[0]?.ctn.children[0]?.ctn.children[0]?.ctn.children[0]?.ctn).toMatchObject({
			repeatCount: "indefinite",
			decel: 100000,
			autoRev: true
		})
	})

	it("writes the build list with its paragraph build", () => {
		const builds = container(0x2b02, [
			container(0x2b08, [
				record(0x2b03, concat(u32(1), u32(0), u32(5), Uint8Array.of(1, 1, 0, 0))),
				record(0x2b09, concat(u32(1), u32(2), Uint8Array.of(1, 0, 0, 0), u32(0)))
			])
		])
		const slide = treeSlide(fadeIn(5), [builds])

		expect(slideTiming(recordAt(slide, 0), [], contextOf(slide, SHAPE5)).xml).toContain(
			'<p:bldLst><p:bldP spid="5" grpId="0" uiExpand="1" build="p" bldLvl="2" animBg="1"/></p:bldLst>'
		)
	})

	it("writes no timing for a root without children", () => {
		const blob = record(0x138b, node(nodeAtom(0, { dur: -1 }), properties(int(20, 9))), 0, 0)
		const slide = container(0x03ee, [container(0x1388, [container(0x138a, [record(0x0fba, utf16("___PPT10").subarray(0, 16)), blob])])])

		expect(slideTiming(recordAt(slide, 0), [], contextOf(slide, SHAPE5))).toEqual({ xml: "", lost: false })
	})

	it("leaves out a tree over the node budget and reports it", () => {
		const slide = treeSlide(fadeIn(5))

		expect(
			slideTiming(recordAt(slide, 0), [], contextOf(slide, SHAPE5, { ...DEFAULT_PRESENTATION_BUDGETS.timing, nodesPerSlide: 3 }))
		).toEqual({
			xml: "",
			lost: true
		})
	})
})

// AnimationInfoContainer (§2.8.1): flags (fAutomatic 0x4), delay, orderID, build type, effect, direction, after effect.
function legacy(options: {
	automatic?: boolean
	delay?: number
	order: number
	build?: number
	effect: number
	direction: number
	after?: number
}): Uint8Array {
	const atom = concat(
		Uint8Array.of(0, 0, 0xff, 0xfe),
		Uint8Array.of(options.automatic === true ? 0x4 : 0, 0x44),
		Uint8Array.of(0, 0),
		u32(0),
		u32(options.delay ?? 0),
		Uint8Array.of(options.order & 0xff, (options.order >> 8) & 0xff, 0, 0),
		Uint8Array.of(options.build ?? 1, options.effect, options.direction, options.after ?? 0, 0, 0, 0, 0)
	)

	return container(0x1014, [record(0x0ff1, atom, 0, 1)])
}

function buildsOf(data: Uint8Array, spids: readonly number[]): PptLegacyBuild[] {
	const out: PptLegacyBuild[] = []
	let at = 0

	for (const spid of spids) {
		const container = recordAt(data, at)

		out.push({ spid, start: container.start, end: container.end })
		at = container.end
	}

	return out
}

describe("ppt Office 97 builds", () => {
	it("plays the shapes in orderID order, clicks and automatic effects after the previous", () => {
		const data = concat(
			legacy({ order: 2, effect: 12, direction: 0, automatic: true, delay: 4000 }),
			legacy({ order: 1, effect: 2, direction: 1 }),
			legacy({ order: 3, effect: 12, direction: 0x10 })
		)
		const shapes = new Map([
			[4, { paragraphs: [] }],
			[5, { paragraphs: [] }],
			[6, { paragraphs: [] }]
		])
		const slide = container(0x03ee, [])
		const context = { ...contextOf(concat(slide, data), shapes) }
		const timing = slideTiming(
			recordAt(context.data, 0),
			buildsOf(context.data.subarray(slide.length), [4, 5, 6]).map(build => ({
				...build,
				start: build.start + slide.length,
				end: build.end + slide.length
			})),
			context
		)
		const tree = timingOf(timing.xml)
		const effects: { presetID: number; presetSubtype: number | undefined; nodeType: string | undefined; delay: unknown }[] = []
		const visit = (node: NonNullable<typeof tree>["root"]): void => {
			if (node.ctn.presetID !== undefined)
				effects.push({
					presetID: node.ctn.presetID,
					presetSubtype: node.ctn.presetSubtype,
					nodeType: node.ctn.nodeType,
					delay: node.ctn.stCondLst[0]?.delay
				})
			else for (const child of node.ctn.children) visit(child)
		}

		if (tree !== undefined) visit(tree.root)

		expect(effects).toEqual([
			{ presetID: 3, presetSubtype: 10, nodeType: "clickEffect", delay: 0 },
			{ presetID: 2, presetSubtype: 8, nodeType: "afterEffect", delay: 4000 },
			{ presetID: 23, presetSubtype: 16, nodeType: "clickEffect", delay: 0 }
		])
		// The automatic effect begins when the blinds before it end.
		expect(timing.xml).toContain('<p:cond delay="500"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="')
	})

	it("builds a text paragraph by paragraph, deeper levels with their paragraph, empty ones left out", () => {
		const data = legacy({ order: 1, build: 2, effect: 5, direction: 0, after: 2 })
		const slide = container(0x03ee, [])
		const all = concat(slide, data)
		const shapes = new Map([
			[
				7,
				{
					paragraphs: [
						{ start: 0, end: 3, level: 0 },
						{ start: 4, end: 7, level: 1 },
						{ start: 8, end: 8, level: 0 },
						{ start: 9, end: 12, level: 0 }
					]
				}
			]
		])
		const container0 = recordAt(all, slide.length)
		const timing = slideTiming(recordAt(all, 0), [{ spid: 7, start: container0.start, end: container0.end }], contextOf(all, shapes))

		expect([...timing.xml.matchAll(/nodeType="(clickEffect|withEffect)"/gu)].map(match => match[1])).toEqual([
			"clickEffect",
			"withEffect",
			"clickEffect"
		])
		expect([...timing.xml.matchAll(/<p:pRg st="(\d+)"/gu)].map(match => match[1])).toEqual([
			"0",
			"0",
			"0",
			"1",
			"1",
			"1",
			"3",
			"3",
			"3"
		])
		expect(timing.xml).toContain('masterRel="nextClick" afterEffect="1"')
		expect(timing.xml).toContain('<p:bldP spid="7" grpId="0" build="p" animBg="1"/>')
	})

	it("ignores the builds when the slide has a PowerPoint 2002 tree", () => {
		const slide = treeSlide(fadeIn(5))
		const data = concat(slide, legacy({ order: 1, effect: 12, direction: 0 }))
		const build = recordAt(data, slide.length)
		const timing = slideTiming(recordAt(data, 0), [{ spid: 5, start: build.start, end: build.end }], contextOf(data, SHAPE5))

		expect(timing.xml).toContain('presetID="10"')
		expect(timing.xml).not.toContain('presetID="2"')
	})
})

describe("ppt paragraph spans", () => {
	it("splits a body at its paragraph marks with each paragraph's level", () => {
		const block = {
			type: 1,
			text: "One\rTwo\r\rFour",
			pfRuns: [
				{ count: 4, level: 0, pf: {} },
				{ count: 4, level: 1, pf: {} },
				{ count: 6, level: 2, pf: {} }
			],
			cfRuns: [],
			fields: [],
			links: []
		} as unknown as TextBlock

		expect(paragraphSpans(block)).toEqual([
			{ start: 0, end: 3, level: 0 },
			{ start: 4, end: 7, level: 1 },
			{ start: 8, end: 8, level: 2 },
			{ start: 9, end: 13, level: 2 }
		])
		expect(paragraphSpans(undefined)).toEqual([])
	})

	it("reads levels from paragraph runs of any stated length without expanding them", () => {
		const block = {
			type: 1,
			text: "A\rB",
			pfRuns: [
				{ count: 2, level: 1, pf: {} },
				{ count: 0x7fffffff, level: 3, pf: {} }
			],
			cfRuns: [],
			fields: [],
			links: []
		} as unknown as TextBlock

		expect(paragraphSpans(block)).toEqual([
			{ start: 0, end: 1, level: 1 },
			{ start: 2, end: 3, level: 3 }
		])
	})

	it("converts a body whose paragraph run states two billion characters (pptFuzz seed 24301)", async () => {
		// StyleTextPropAtom: one paragraph run of 0x7fffffff characters at indent level 3, one character run.
		const style = concat(u32(0x7fffffff), Uint8Array.of(3, 0), u32(0), u32(0x7fffffff), u32(0))
		const deck = await buildPpt({
			slides: [
				{
					shapes: [
						{
							text: "One\rTwo",
							rawStyle: style,
							anchor: [100, 100, 2000, 600],
							clientData: [
								container(0x1014, [record(0x0ff1, concat(new Uint8Array(20), Uint8Array.of(2, 5, 0, 0, 0, 0, 0, 0)), 0, 1)])
							]
						}
					]
				}
			]
		})
		const converted = await pptToPptx(bytesSource(deck.bytes))

		expect(converted.kind === "converted" || converted.reason).toBe(true)
	})
})
