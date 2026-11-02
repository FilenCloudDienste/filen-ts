import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideRef, Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { encodePng } from "./oracles/presentation/pixel"
import { driveSession } from "./odpWriteDrive"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { buildPptx } from "./pptxFixtures"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"

const FLIPS: [boolean, boolean, number][] = [
	[true, false, 0],
	[false, true, 0],
	[true, true, 0],
	[true, false, 30 * 60000],
	[false, true, 45 * 60000]
]

function png(): Uint8Array {
	const w = 40,
		h = 30,
		data = new Uint8Array(w * h * 4)
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const at = (y * w + x) * 4
			const red = x < 12 && y < 10
			data.set(red ? [220, 30, 30, 255] : x > y ? [30, 160, 60, 255] : [240, 220, 40, 255], at)
		}
	return encodePng({ width: w, height: h, data } as never)
}

const txt = (t: string) =>
	`<p:txBody><a:bodyPr anchor="t"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-GB" sz="1800"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:rPr><a:t>${t}</a:t></a:r></a:p></p:txBody>`
const sp = (id: number, name: string, prst: string, x: number, y: number, cx: number, cy: number, extra = "", body = "") =>
	`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm${extra}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>${body}</p:sp>`
const pic = (id: number, x: number, y: number) =>
	`<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1600000" cy="1200000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`

function group(flipH: boolean, flipV: boolean, rot: number, at = { x: 1_000_000, y: 1_000_000, cx: 7_600_000, cy: 3_200_000 }): string {
	const members =
		sp(3, "Arrow", "rightArrow", 1_000_000, 1_000_000, 2_400_000, 1_200_000, "", txt("Arrow")) +
		sp(4, "Box", "rect", 3_800_000, 1_000_000, 2_400_000, 1_200_000, ' rot="1200000"', txt("Text box")) +
		sp(5, "Tri", "rtTriangle", 1_000_000, 2_600_000, 2_000_000, 1_600_000, "", txt("Tri")) +
		pic(6, 3_800_000, 2_600_000) +
		'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="7" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="600000"><a:off x="6600000" y="1000000"/><a:ext cx="2000000" cy="2800000"/><a:chOff x="6600000" y="1000000"/><a:chExt cx="2000000" cy="2800000"/></a:xfrm></p:grpSpPr>' +
		sp(8, "Moon", "moon", 6_600_000, 1_000_000, 1_000_000, 1_400_000) +
		sp(9, "Star", "star5", 7_400_000, 2_400_000, 1_200_000, 1_400_000, ' flipV="1"') +
		"</p:grpSp>"
	const flips = `${flipH ? ' flipH="1"' : ""}${flipV ? ' flipV="1"' : ""}${rot === 0 ? "" : ` rot="${rot}"`}`
	return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="2" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm${flips}><a:off x="${at.x}" y="${at.y}"/><a:ext cx="${at.cx}" cy="${at.cy}"/><a:chOff x="${at.x}" y="${at.y}"/><a:chExt cx="${at.cx}" cy="${at.cy}"/></a:xfrm></p:grpSpPr>${members}</p:grpSp>`
}

function deck(flipped: boolean, at?: { x: number; y: number; cx: number; cy: number }): Uint8Array {
	return buildPptx({
		slides: FLIPS.map(([h, v, r]) => ({
			shapes: group(flipped && h, flipped && v, flipped ? r : 0, at),
			rels: [["rId9", "image", "../media/image1.png"]]
		})),
		parts: { "ppt/media/image1.png": { data: png(), type: "image/png" } }
	})
}

// A group flipped in an ODP: ODF holds no mirrored group (draw:g has no transform), so each member is written mirrored
// in the group's box, its own mirror turned, as LibreOffice stores a flipped group; DrawingML's text stays as it
// reads under a horizontal flip and turns half a turn under a vertical one. Its LibreOffice render matches
// LibreOffice's pptx import of the same flipped group (checked outside the suite: ink 0 on every case here).

const FLIPPED: readonly (readonly [string, boolean, boolean])[] = [
	["Arrow", true, false],
	["Box", false, false],
	["Tri", true, false],
	["Picture", true, false]
]

describe("a group flipped in an ODP", () => {
	it(
		"writes its members mirrored, reads back as an unflipped group of mirrored members, and undoes to the source",
		{ timeout: 60_000 },
		async () => {
			const plain = await freshFromPptx(deck(false))

			if ("kind" in plain) throw new Error(plain.reason)

			const d = await driveSession(plain.bytes)

			for (const [k, [h, v, r]] of FLIPS.entries()) {
				const slide = d.session.deck.slides[k] as SlideRef
				const group = ((await odpParts(d.session.deck)?.slide(slide))?.shapes ?? []).find(
					shape => shape.kind === "grpSp"
				) as ShapeNode
				const box = group.xfrm as Xfrm

				expect(
					(
						await d.command({
							family: "shape",
							kind: "setXfrm",
							target: { slide, id: group.id },
							xfrm: { ...box, flipH: h, flipV: v, rot: r }
						})
					).ok
				).toBe(true)
			}

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")

			const read = await openOdpDeck(saved.bytes as Uint8Array)
			const first = read.deck.nodes.get(read.deck.slides[0] as SlideRef)?.shapes.find(shape => shape.kind === "grpSp")

			expect(first?.xfrm?.flipH).toBe(false)

			// Under a horizontal flip: the arrow and triangle mirrored, the text box (a rectangle) turned the other way
			// instead, the picture mirrored by its style.
			const members = new Map((first?.children ?? []).map(member => [member.name, member]))

			for (const [name, flipH, flipV] of FLIPPED) {
				expect(members.get(name)?.xfrm?.flipH, name).toBe(flipH)
				expect(members.get(name)?.xfrm?.flipV, name).toBe(flipV)
			}

			expect(members.get("Box")?.xfrm?.rot).toBe(21_600_000 - 1_200_000)

			const content = text((await entriesOf(saved.bytes as Uint8Array)).get("content.xml"))

			expect(content).toContain('style:mirror="horizontal"')
			expect(content).not.toContain('style:mirror="vertical"')

			for (let k = 0; k < FLIPS.length; k++) expect((await d.undo()).ok).toBe(true)

			const back = await d.save()

			expect(text((await entriesOf(back.bytes as Uint8Array)).get("content.xml"))).toBe(
				text((await entriesOf(plain.bytes)).get("content.xml"))
			)
		}
	)
})
