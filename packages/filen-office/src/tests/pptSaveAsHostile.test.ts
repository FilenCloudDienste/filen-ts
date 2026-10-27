import { Zlib } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource, memorySink, type ByteSink } from "../core/opc/index"
import { slideTiming, type PptAnimContext, type PptAnimShape } from "../core/ppt/anim"
import { recordAt, RecordCounter } from "../core/ppt/records"
import { pptToPptx, type PptConversion } from "../core/ppt/toPptx"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { pptSaveAs } from "../dom/presentation/engine/convert"
import { liveHeap, liveHeapNow } from "./liveHeap"
import { buildPpt, concat, container, FIXTURE_PNG, record, type FixtureOptions } from "./pptFixtures"
import { cpuMs } from "./timing"

// Hostile PowerPoint 97–2003 input the converter must survive with its deck: damaged time trees and comments, unpaired
// surrogates, numbers no attribute can hold, impossible dates, storage bombs and quadratic targets.

function u16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

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

	for (let k = 0; k < text.length; k++) {
		out[2 * k] = text.charCodeAt(k) & 0xff
		out[2 * k + 1] = text.charCodeAt(k) >> 8
	}

	return out
}

const int = (id: number, value: number): Uint8Array => record(0xf142, concat(Uint8Array.of(1), u32(value)), id)
const str = (instance: number, value: string): Uint8Array => record(0xf142, concat(Uint8Array.of(3), utf16(value)), instance)
const properties = (...items: Uint8Array[]): Uint8Array => container(0xf13d, items)
const node = (...children: Uint8Array[]): Uint8Array => container(0xf144, children, 1)

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

// The tree of one click playing `effect`.
function tree(effect: Uint8Array[]): Uint8Array {
	return node(
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
}

function pp10(...blob: Uint8Array[]): Uint8Array {
	return container(0x1388, [container(0x138a, [record(0x0fba, utf16("___PPT10").subarray(0, 16)), record(0x138b, concat(...blob))])])
}

function contextOf(data: Uint8Array, shapes: ReadonlyMap<number, PptAnimShape>): PptAnimContext {
	return {
		data,
		counter: new RecordCounter(),
		shapes,
		sound: () => undefined,
		embeddedSound: () => undefined,
		scheme: [0xffffff, 0, 0x808080, 0, 0x99cc00, 0xcc3333, 0xffcccc, 0xb2b2b2],
		budgets: DEFAULT_PRESENTATION_BUDGETS.timing
	}
}

async function convert(options: Omit<FixtureOptions, "png">): Promise<PptConversion> {
	const converted = await pptToPptx(bytesSource((await buildPpt({ png: FIXTURE_PNG, ...options })).bytes))

	if (converted.kind !== "converted") throw new Error(`refused: ${converted.reason}`)

	return converted
}

async function part(converted: PptConversion, name: string): Promise<string> {
	return new TextDecoder().decode(await converted.pptx.read(name))
}

const TEXT = { text: "Hi", anchor: [100, 100, 2000, 600] as const }

describe("ppt damaged PowerPoint 2002 tag", () => {
	it("loses only the slide's animation to a damaged record deep in its time tree", async () => {
		// A child of the root's child claims 1000 bytes it does not have.
		const bad = concat(Uint8Array.of(0x0f, 0x00), u16(0xf127), u32(1000))
		const root = node(nodeAtom(0, { dur: -1 }), properties(int(20, 9)), container(0xf144, [bad], 1))
		const converted = await convert({ slides: [{ shapes: [TEXT], records: [pp10(root)] }, { shapes: [TEXT] }] })

		expect(converted.losses).toEqual([{ kind: "animation", count: 1, slides: [1] }])
		expect(await part(converted, "ppt/slides/slide1.xml")).not.toContain("<p:timing")
	})

	it("loses only the slide's comments to a damaged comment record", async () => {
		const comment = container(0x2ee0, [concat(Uint8Array.of(0, 0), u16(0x0fba), u32(1000))])
		const converted = await convert({ slides: [{ shapes: [TEXT], records: [pp10(comment)] }] })

		expect(converted.losses).toEqual([{ kind: "comment", count: 1, slides: [1] }])
		expect(converted.pptx.has("ppt/comments/comment1.xml")).toBe(false)
	})

	it("loses the slide's animation and comments to a damaged tag", async () => {
		const tag = container(0x1388, [container(0x138a, [concat(Uint8Array.of(0, 0), u16(0x0fba), u32(1000))])])
		const converted = await convert({ slides: [{ shapes: [TEXT], records: [tag] }] })

		expect(converted.losses).toEqual([
			{ kind: "animation", count: 1, slides: [1] },
			{ kind: "comment", count: 1, slides: [1] }
		])
	})
})

describe("ppt hostile strings", () => {
	it("links a movie whose path holds an unpaired surrogate with U+FFFD in its place", async () => {
		const path = new Uint8Array([0x43, 0, 0x3a, 0, 0x5c, 0, 0x00, 0xd8, 0x61, 0])
		const converted = await convert({
			slides: [{ shapes: [{ picture: true, anchor: [100, 100, 1000, 800], clientData: [record(0x0bc1, u32(1))] }] }],
			documentRecords: [
				container(0x0409, [container(0x1006, [container(0x1005, [record(0x1004, concat(u32(1), u32(0))), record(0x0fba, path)])])])
			]
		})

		expect(await part(converted, "ppt/slides/_rels/slide1.xml.rels")).toContain('Target="file:///C:/%EF%BF%BDa"')
	})

	it("writes an unpaired surrogate in a comment as U+FFFD", async () => {
		const text = new Uint8Array([0x41, 0, 0x00, 0xdc, 0x42, 0])
		const comment = container(0x2ee0, [
			record(0x0fba, utf16("Ann").subarray(0, 6), 0),
			record(0x0fba, text, 1),
			record(0x2ee1, concat(u32(1), ...[2020, 2, 0, 29, 10, 30, 0, 0].map(u16), u32(100), u32(200)))
		])
		const converted = await convert({ slides: [{ shapes: [TEXT], records: [pp10(comment)] }] })

		expect(await part(converted, "ppt/comments/comment1.xml")).toContain("<p:text>A\ufffdB</p:text>")
	})
})

describe("ppt hostile numbers and dates", () => {
	// A fade-in on shape `spid` with float modifiers (accel NaN, spd +Infinity, repeatDur 1e30) and a rotation by 1e30°.
	function hostileEffect(spid: number): Uint8Array[] {
		return [
			nodeAtom(0, { fill: 0 }),
			properties(int(20, 1), int(9, 10), int(10, 0), int(11, 1), int(19, 0)),
			condition(1, 0, 0, 0),
			record(0xf129, concat(u32(3), f32(Number.NaN))),
			record(0xf129, concat(u32(2), f32(Number.POSITIVE_INFINITY))),
			record(0xf129, concat(u32(1), f32(1e30))),
			node(
				nodeAtom(3, { dur: 500 }),
				container(0xf12f, [record(0xf138, concat(u32(0x1), f32(1e30), f32(0), f32(0), u32(0))), behavior(shapeTarget(spid))])
			)
		]
	}

	it("writes no NaN, Infinity or exponent into a time tree, clamping or leaving the values out, and reports it", () => {
		const slide = container(0x03ee, [pp10(tree(hostileEffect(5)))])
		const timing = slideTiming(recordAt(slide, 0), [], contextOf(slide, new Map([[5, { paragraphs: [] }]])))

		expect(timing.xml).toContain("<p:animRot")
		expect(timing.xml).not.toMatch(/="[^"]*(NaN|Infinity|[eE][+-]?\d)[^"]*"/u)
		expect(timing.xml).toContain(' spd="2147483647"')
		expect(timing.xml).toContain(' repeatDur="4294967295"')
		expect(timing.xml).toContain(' by="2147483647"')
		expect(timing.xml).not.toContain(" accel=")
		expect(timing.lost).toBe(true)
	})

	it("reports a deck whose time tree held such numbers as having lost animation", async () => {
		const converted = await convert({ slides: [{ shapes: [TEXT], records: [pp10(tree(hostileEffect(0x1001)))] }] })

		expect(converted.losses).toEqual([{ kind: "animation", count: 1, slides: [1] }])
	})

	function commentAt(date: readonly number[], text = "Note"): Uint8Array {
		return container(0x2ee0, [
			record(0x0fba, utf16("Ann").subarray(0, 6), 0),
			record(0x0fba, utf16(text).subarray(0, text.length * 2), 1),
			record(0x2ee1, concat(u32(1), ...date.map(u16), u32(100), u32(200)))
		])
	}

	it("leaves out a comment time that is no calendar date, keeping leap days", async () => {
		const converted = await convert({
			slides: [
				{ shapes: [TEXT], records: [pp10(commentAt([2021, 2, 0, 31, 10, 30, 0, 0]))] },
				{ shapes: [TEXT], records: [pp10(commentAt([2021, 2, 0, 29, 10, 30, 0, 0]))] },
				{ shapes: [TEXT], records: [pp10(commentAt([2020, 2, 0, 29, 10, 30, 0, 0]))] },
				{ shapes: [TEXT], records: [pp10(commentAt([1900, 2, 0, 29, 10, 30, 0, 0]))] },
				{ shapes: [TEXT], records: [pp10(commentAt([2021, 4, 0, 31, 10, 30, 0, 0]))] }
			]
		})
		const dates = await Promise.all(
			[1, 2, 3, 4, 5].map(async n => /dt="([^"]*)"/u.exec(await part(converted, `ppt/comments/comment${String(n)}.xml`))?.[1])
		)

		expect(dates).toEqual([undefined, undefined, "2020-02-29T10:30:00.000", undefined, undefined])
	})

	it("writes a comment's carriage returns as line feeds", async () => {
		const converted = await convert({
			slides: [{ shapes: [TEXT], records: [pp10(commentAt([2020, 5, 0, 1, 10, 30, 0, 0], "One\rTwo"))] }]
		})

		expect(await part(converted, "ppt/comments/comment1.xml")).toContain("<p:text>One\nTwo</p:text>")
	})
})

describe("ppt time tree targets", () => {
	it("finds the paragraphs of many text-range targets over a long text in linear time", { timeout: 60_000 }, () => {
		const paragraphs = Array.from({ length: 60_000 }, (_, k) => ({ start: k * 2, end: k * 2 + 1, level: 0 }))
		const effects: Uint8Array[] = []

		for (let k = 0; k < 9000; k++) {
			const first = (k * 7) % 59_000

			effects.push(
				node(
					nodeAtom(3, { dur: 1 }),
					container(0xf131, [
						record(0xf13a, concat(u32(0x1), u32(1))),
						str(1, "visible"),
						behavior(shapeTarget(5, 2, first * 2, first * 2 + 3), "style.visibility")
					])
				)
			)
		}

		const slide = container(0x03ee, [pp10(tree([nodeAtom(0, { fill: 0 }), ...effects]))])
		const start = cpuMs()
		const timing = slideTiming(recordAt(slide, 0), [], contextOf(slide, new Map([[5, { paragraphs }]])))
		const spent = cpuMs() - start

		expect(timing.xml).toContain('<p:pRg st="7" end="8"/>')
		expect(spent).toBeLessThan(400)
	})
})

describe("ppt Office 97 builds on master placeholders", () => {
	// AnimationInfoContainer (§2.8.1): a fly-in from the left, built by first-level paragraphs.
	const build = container(0x1014, [
		record(
			0x0ff1,
			concat(Uint8Array.of(0, 0, 0xff, 0xfe, 0, 0x44, 0, 0), u32(0), u32(0), Uint8Array.of(1, 0, 0, 0, 2, 12, 0, 0, 0, 0, 0, 0)),
			0,
			1
		)
	])

	it("plays the master body's build on each slide body without one of its own", async () => {
		const converted = await convert({
			masterShapes: [
				{ text: "Master title", textType: 0, placeholder: { type: 1, position: 0 }, anchor: [100, 300, 5400, 700] },
				{
					text: "Master body",
					textType: 1,
					placeholder: { type: 2, position: 1 },
					anchor: [900, 300, 5400, 4000],
					clientData: [build]
				}
			],
			slides: [
				{
					shapes: [
						{ text: "Title", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] },
						{ text: "One\rTwo", textType: 1, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] }
					]
				},
				{ shapes: [{ text: "Plain", anchor: [100, 100, 2000, 600] }] }
			]
		})
		const first = await part(converted, "ppt/slides/slide1.xml")

		// The body is the slide's second shape (spid 0x1002); its two paragraphs build one by one.
		expect(first).toContain('<p:bldP spid="4098" grpId="0" build="p" animBg="1"/>')
		expect(new Set(first.match(/<p:pRg st="(\d)" end="\1"\/>/gu))).toEqual(
			new Set(['<p:pRg st="0" end="0"/>', '<p:pRg st="1" end="1"/>'])
		)
		expect(first).not.toContain('spid="4097"')
		expect(await part(converted, "ppt/slides/slide2.xml")).not.toContain("<p:timing")
		expect(converted.losses).toEqual([])
	})

	const masterShapes = [
		{
			text: "Master body",
			textType: 1,
			placeholder: { type: 2, position: 1 },
			anchor: [900, 300, 5400, 4000] as const,
			clientData: [build]
		}
	]
	const body = { text: "One\rTwo", textType: 1, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] as const }

	it("plays the master's build on a slide whose PowerPoint 2002 tree is an empty root, not the slide's own", async () => {
		const emptyRoot = pp10(node(nodeAtom(0, { dur: -1 }), properties(int(20, 9))))
		const converted = await convert({
			masterShapes,
			slides: [{ shapes: [{ ...TEXT, clientData: [build] }, body], records: [emptyRoot] }]
		})
		const slide = await part(converted, "ppt/slides/slide1.xml")

		expect(slide).toContain('<p:bldP spid="4098" grpId="0" build="p" animBg="1"/>')
		expect(slide).not.toContain('spid="4097"')
	})

	it("reports the master's build on a placeholder a slide's own tree does not animate", async () => {
		const own = tree([
			nodeAtom(0, { fill: 0 }),
			properties(int(20, 1), int(9, 10), int(10, 0), int(11, 1)),
			node(
				nodeAtom(3, { dur: 1 }),
				container(0xf131, [
					record(0xf13a, concat(u32(0x1), u32(1))),
					str(1, "visible"),
					behavior(shapeTarget(0x1001), "style.visibility")
				])
			)
		])
		const converted = await convert({ masterShapes, slides: [{ shapes: [TEXT, body], records: [pp10(own)] }] })

		expect(await part(converted, "ppt/slides/slide1.xml")).toContain('<p:spTgt spid="4097"/>')
		expect(converted.losses).toEqual([{ kind: "animation", count: 1, slides: [1] }])
	})
})

describe("ppt embedded object frames", () => {
	const STORAGE = Uint8Array.from({ length: 4096 }, (_, k) => (k * 31) % 251)
	const embed = container(0x0409, [
		container(0x0fcc, [
			record(0x0fcd, concat(u32(0), u32(0))),
			record(0x0fc3, concat(u32(1), u32(0), u32(1), u32(3), u32(100), u32(0))),
			record(0x0fba, utf16("Excel.Sheet.8").subarray(0, 26), 2)
		])
	])

	it("keeps the frame's rotation, flip and placeholder, and the picture's border inside", async () => {
		const converted = await convert({
			slides: [
				{
					shapes: [
						{
							picture: true,
							oleShape: true,
							flipH: true,
							placeholder: { type: 19, position: 1 },
							anchor: [100, 100, 1000, 800],
							// Rotated 30° (16.16 fixed point); a 2 pt red line.
							properties: [
								[0x0004, 30 << 16],
								[0x01c0, 0x0000ff],
								[0x01cb, 25400],
								[0x01ff, 0x80008]
							],
							clientData: [record(0x0bc1, u32(1))]
						}
					]
				}
			],
			documentRecords: [embed],
			objects: new Map([[100, record(0x1011, concat(u32(STORAGE.length), new Uint8Array(zlib(STORAGE))), 1)]])
		})
		const slide = await part(converted, "ppt/slides/slide1.xml")
		const frame = slide.slice(slide.indexOf("<p:graphicFrame>"), slide.indexOf("<a:graphic>"))

		expect(frame).toContain('<p:nvPr><p:ph type="obj" idx="1"/></p:nvPr>')
		expect(frame).toContain('<p:xfrm rot="1800000" flipH="1">')
		expect(slide).toMatch(/<p:oleObj[^>]*><p:embed\/><p:pic>.*<a:ln w="25400"[^>]*>.*<\/p:pic><\/p:oleObj>/u)
	})
})

// zlib (RFC 1950) bytes of `data`, or of `size` zeros fed in 1 MiB steps so the input is never held.
function zlib(data: Uint8Array | number): Uint8Array {
	const parts: Uint8Array[] = []
	const stream = new Zlib({ level: 9 }, chunk => parts.push(chunk))

	if (typeof data !== "number") stream.push(data, true)
	else {
		const zeros = new Uint8Array(1024 * 1024)

		for (let left = data; left > 0; left -= zeros.length)
			stream.push(zeros.subarray(0, Math.min(zeros.length, left)), left <= zeros.length)
	}

	return concat(...parts)
}

// Bytes that do not compress (xorshift32).
function noise(length: number): Uint8Array {
	let state = 0x9e3779b9

	return Uint8Array.from({ length }, () => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		return state & 0xff
	})
}

describe("ppt embedded object storage bombs", () => {
	const SIZE = 128 * 1024 * 1024
	const objectOf = (body: Uint8Array, size: number): FixtureOptions => ({
		png: FIXTURE_PNG,
		slides: [{ shapes: [{ picture: true, oleShape: true, anchor: [100, 100, 1000, 800], clientData: [record(0x0bc1, u32(1))] }] }],
		documentRecords: [
			container(0x0409, [
				container(0x0fcc, [
					record(0x0fcd, concat(u32(0), u32(0))),
					record(0x0fc3, concat(u32(1), u32(0), u32(1), u32(3), u32(100), u32(0))),
					record(0x0fba, utf16("Excel.Sheet.8").subarray(0, 26), 2)
				])
			])
		],
		objects: new Map([[100, record(0x1011, concat(u32(size), body), 1)]])
	})
	const nullSink = (): ByteSink => ({ write: () => Promise.resolve(), close: () => Promise.resolve() })

	it("never inflates a storage at open and streams it into the copy in bounded memory", { timeout: 300_000 }, async () => {
		const built = await buildPpt(objectOf(zlib(SIZE), SIZE))
		const start = cpuMs()
		const converted = await pptToPptx(bytesSource(built.bytes))
		const openCpu = cpuMs() - start

		if (converted.kind !== "converted") throw new Error(converted.reason)

		expect(openCpu).toBeLessThan(250)
		expect(converted.pptx.entry("ppt/embeddings/oleObject1.bin")?.uncompressedSize).toBe(SIZE)

		const before = await liveHeap()
		let peak = 0
		const slicing = {
			sliceMs: 20,
			now: () => performance.now(),
			pause: () => {
				peak = Math.max(peak, liveHeapNow() - before)

				return new Promise<void>(resolve => setImmediate(resolve))
			}
		}

		await pptSaveAs(converted.pptx, undefined, nullSink(), slicing)

		expect(peak).toBeGreaterThan(0)
		expect(peak).toBeLessThan(48 * 1024 * 1024)
		expect(converted.losses).toEqual([])
	})

	it("pads a storage that ends early to its stated size and reports it once written", async () => {
		const sink = memorySink()
		const converted = await pptToPptx(bytesSource((await buildPpt(objectOf(zlib(noise(5000)).subarray(0, 400), 5000))).bytes))

		if (converted.kind !== "converted") throw new Error(converted.reason)

		expect(converted.losses).toEqual([])

		await pptSaveAs(converted.pptx, undefined, sink)

		expect(converted.losses).toEqual([{ kind: "oleObject", count: 1, slides: [1] }])
		expect(sink.bytes().length).toBeGreaterThan(0)

		const bytes = await converted.pptx.read("ppt/embeddings/oleObject1.bin")

		expect(bytes.length).toBe(5000)
		expect(bytes[4999]).toBe(0)
	})
})
