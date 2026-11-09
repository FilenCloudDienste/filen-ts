import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { decodeUtf8, parseXml } from "@filen/office/core/xml"
import type { DocBlock, DocModel } from "../core/doc/model"
import { blocksIn } from "../core/doc/toDocx/convert"
import { convertDocToDocx, type DocConversionResult } from "../core/doc/toDocx/index"
import { buildDoc, plc, prl } from "./docFixtures"

// Floating OfficeArt shapes of a Word binary document as DrawingML: groups, preset and freeform geometry, rotation and
// the Word 2000 positioning properties.

function record(version: number, instance: number, type: number, body: readonly number[]): number[] {
	const length = body.length

	return [(version | (instance << 4)) & 0xff, (instance << 4) >>> 8, type & 0xff, type >>> 8, ...u32(length), ...body]
}

function u32(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u16(value: number): number[] {
	return [value & 0xff, (value >>> 8) & 0xff]
}

// [pid, value] or [pid, complex bytes].
type Property = readonly [number, number | readonly number[]]

function opt(properties: readonly Property[]): number[] {
	const fixed: number[] = []
	const complex: number[] = []

	for (const [pid, value] of properties) {
		if (typeof value === "number") {
			fixed.push(...u16(pid), ...u32(value))
		} else {
			fixed.push(...u16(pid | 0x8000), ...u32(value.length))
			complex.push(...value)
		}
	}

	return record(3, properties.length, 0xf00b, [...fixed, ...complex])
}

function ltrb(type: number, rect: readonly [number, number, number, number]): number[] {
	return record(0, 0, type, rect.flatMap(u32))
}

interface ShapeSpec {
	readonly spid: number
	readonly type: number
	readonly properties?: readonly Property[]
	readonly childAnchor?: readonly [number, number, number, number]
}

function shape(spec: ShapeSpec, flags: number): number[] {
	return record(0xf, 0, 0xf004, [
		...record(2, spec.type, 0xf00a, [...u32(spec.spid), ...u32(flags)]),
		...(spec.properties === undefined ? [] : opt(spec.properties)),
		...(spec.childAnchor === undefined ? [] : ltrb(0xf00f, spec.childAnchor))
	])
}

interface GroupSpec {
	readonly spid: number
	readonly rect: readonly [number, number, number, number]
	readonly childAnchor?: readonly [number, number, number, number]
	readonly members: readonly (ShapeSpec | GroupSpec)[]
}

function group(spec: GroupSpec): number[] {
	const self = record(0xf, 0, 0xf004, [
		...ltrb(0xf009, spec.rect),
		...record(2, 0, 0xf00a, [...u32(spec.spid), ...u32(0x201 | (spec.childAnchor === undefined ? 0 : 0x2))]),
		...(spec.childAnchor === undefined ? [] : ltrb(0xf00f, spec.childAnchor))
	])
	const members = spec.members.flatMap(member => ("members" in member ? group(member) : shape(member, 0xa02)))

	return record(0xf, 0, 0xf003, [...self, ...members])
}

// OfficeArtContent: no BLIP store, and the main document's drawing with the given top-level shapes and groups.
function drawing(...items: readonly (ShapeSpec | GroupSpec)[]): Uint8Array {
	const patriarch = shape({ spid: 1024, type: 0 }, 0x5)
	const top = items.flatMap(item => ("members" in item ? group(item) : shape(item, 0xa00)))
	const spgr = record(0xf, 0, 0xf003, [...patriarch, ...top])
	const dg = record(0xf, 0, 0xf002, spgr)

	return Uint8Array.from([...record(0xf, 0, 0xf000, []), 0, ...dg])
}

// FSPA ([MS-DOC] §2.8.25): spid, the rectangle in twips, flags (wr 3: in front of text), cTxbx.
function fspa(spid: number, rect: readonly [number, number, number, number]): number[] {
	return [...u32(spid), ...rect.flatMap(u32), ...u16(3 << 5), ...u32(0)]
}

async function convert(
	art: Uint8Array,
	spid: number,
	rect: readonly [number, number, number, number] = [0, 0, 1440, 1440]
): Promise<{ readonly xml: string; readonly result: DocConversionResult }> {
	const result = await convertDocToDocx(
		bytesSource(
			await buildDoc({
				pieces: [{ text: "\u0008\r" }],
				runs: [{ start: 0, end: 1, grpprl: prl.toggle(0x0855, 1) }],
				structures: { dggInfo: art, plcSpaMom: plc([0, 1], [fspa(spid, rect)]) }
			})
		)
	)
	const bytes = result.parts.get("word/document.xml")

	if (bytes === undefined) throw new Error("no document part")

	parseXml(bytes)

	return { xml: decodeUtf8(bytes), result }
}

// UTF-16 with a terminator.
function utf16(value: string): number[] {
	return [...value].flatMap(char => u16(char.charCodeAt(0))).concat([0, 0])
}

describe("Word binary floating shapes to DrawingML", () => {
	it("draws a group as a wpg:wgp, its members at their child anchors in the group's coordinate space", async () => {
		const { xml, result } = await convert(
			drawing({
				spid: 2000,
				rect: [0, 0, 1000, 1000],
				members: [
					{ spid: 2001, type: 3, childAnchor: [0, 0, 500, 500] },
					{
						spid: 2002,
						rect: [0, 0, 100, 100],
						childAnchor: [500, 500, 1000, 1000],
						members: [{ spid: 2003, type: 1, properties: [[0x00c0, utf16("Hi")]], childAnchor: [0, 0, 100, 100] }]
					}
				]
			}),
			2000
		)

		expect(xml).toContain('<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp>')
		expect(xml).toContain('<a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/>')
		expect(xml).toContain('<a:off x="0" y="0"/><a:ext cx="500" cy="500"/></a:xfrm><a:prstGeom prst="ellipse">')
		// The subgroup at its anchor, its own space inside it, its WordArt member in that space.
		expect(xml).toContain(
			'<wpg:grpSp><wpg:cNvGrpSpPr/><wpg:grpSpPr><a:xfrm><a:off x="500" y="500"/><a:ext cx="500" cy="500"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/>'
		)
		expect(xml).toContain('<a:off x="0" y="0"/><a:ext cx="100" cy="100"/>')
		expect(xml).toContain(">Hi</w:t>")
		// One drawing; no placeholder.
		expect(xml.match(/<w:drawing>/gu)?.length).toBe(1)
		expect(xml).not.toContain("Not converted")
		expect(result.notConverted).toEqual([{ kind: "wordArt", count: 1 }])
	})

	it("draws every built-in AutoShape type with its adjust values, and freeforms from their vertices", async () => {
		const star = await convert(drawing({ spid: 2000, type: 187 }), 2000)

		expect(star.xml).toContain('prst="star4"')
		expect(star.result.notConverted).toEqual([])

		// roundRect's adjust (MS-ODRAW §2.3.6.10, of 21600) as a guide of 100000.
		const rounded = await convert(drawing({ spid: 2000, type: 2, properties: [[0x0147, 5400]] }), 2000)

		expect(rounded.xml).toContain('<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>')

		// A freeform triangle: pVertices as an IMsoArray of 8-byte POINTs.
		const vertices = [...u16(3), ...u16(3), ...u16(8), ...[0, 0, 21600, 0, 0, 21600].flatMap(u32)]
		const freeform = await convert(drawing({ spid: 2000, type: 0, properties: [[0x0145, vertices]] }), 2000)

		expect(freeform.xml).toContain("<a:custGeom>")
		expect(freeform.xml).toContain(
			'<a:path w="21600" h="21600"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="21600" y="0"/></a:lnTo><a:lnTo><a:pt x="0" y="21600"/></a:lnTo><a:close/></a:path>'
		)
		expect(freeform.xml).not.toContain("Not converted")
		expect(freeform.result.notConverted).toEqual([])
	})

	it("positions by posrelh / posrelv and aligns by posh / posv where the shape sets them", async () => {
		const { xml } = await convert(
			drawing({
				spid: 2000,
				type: 1,
				properties: [
					[0x038f, 2],
					[0x0390, 3],
					[0x0391, 0],
					[0x0392, 3]
				]
			}),
			2000,
			[0, 240, 1440, 1680]
		)

		expect(xml).toContain('<wp:positionH relativeFrom="character"><wp:align>center</wp:align></wp:positionH>')
		expect(xml).toContain(`<wp:positionV relativeFrom="line"><wp:posOffset>${String(240 * 635)}</wp:posOffset></wp:positionV>`)
	})

	it("swaps a shape turned by 90° back to its own width and height about the stored rectangle's centre", async () => {
		const { xml } = await convert(drawing({ spid: 2000, type: 1, properties: [[0x0004, 90 * 65536]] }), 2000, [0, 0, 2880, 1440])

		expect(xml).toContain(`<wp:extent cx="${String(1440 * 635)}" cy="${String(2880 * 635)}"/>`)
		expect(xml).toContain(`<wp:posOffset>${String(720 * 635)}</wp:posOffset></wp:positionH>`)
		expect(xml).toContain(`<wp:posOffset>${String(-720 * 635)}</wp:posOffset></wp:positionV>`)
		expect(xml).toContain('<a:xfrm rot="5400000"')
	})
})

describe("story ranges", () => {
	it("finds a range's blocks by bisection, visiting only them after the search", () => {
		const count = 20_000
		const paragraphs = Array.from({ length: count }, (_, k) => ({ start: 2 * k, end: 2 * k + 2 }))
		let reads = 0
		const counted = new Proxy(paragraphs, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/u.test(key)) reads++

				return Reflect.get(target, key, receiver) as unknown
			}
		})
		const model = { paragraphs: counted } as unknown as DocModel
		const blocks: DocBlock[] = Array.from({ length: count }, (_, index) => ({ kind: "paragraph", index }))

		// One range per two paragraphs: every story of a document with as many notes as it has paragraphs.
		for (let k = 0; k < count; k += 2) {
			const found = blocksIn(model, blocks, 2 * k, 2 * k + 4)

			expect(found.length).toBe(2)
			expect(found[0]).toBe(blocks[k])
		}

		// log2(20000) ≈ 15 reads to find each range, and three to walk it; a scan would read 20000 per range.
		expect(reads).toBeLessThan((count / 2) * 20)
		expect(blocksIn(model, blocks, 0, 2 * count)).toBe(blocks)
	})
})
