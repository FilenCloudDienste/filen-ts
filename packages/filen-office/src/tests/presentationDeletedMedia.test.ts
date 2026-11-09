import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { readImage } from "../dom/presentation/engine/view"
import { CORPUS_DIR } from "./corpusDir"
import { modelVsFile, reopened } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { png } from "./presentationObjectsFixtures"

// A picture of the source deck deleted: its image leaves the file with the save once nothing in the deck relates it
// (its relationship and content-type override with it; the manifest entry in ODP), and an undo after that save puts
// the picture back with its bytes. An image another slide still shows stays.

type Format = "pptx" | "odp"

const IMAGE = png(3, 2)

const pic = (id: number, rId: string): string =>
	`<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="Picture ${String(id)}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
	`<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
	'<p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

function pptx(shared: boolean): Uint8Array {
	const slide = (picture: boolean) => ({
		shapes: sp(2, "Title 1", 'type="title"', "", body(para("Pictures"))) + (picture ? pic(4, "rId9") : ""),
		rels: picture ? ([["rId9", "image", "../media/image1.png"]] as const) : []
	})

	return buildPptx({
		slides: [slide(true), slide(shared)],
		parts: { "ppt/media/image1.png": { data: IMAGE, type: "image/png" } }
	})
}

function odp(shared: boolean): Uint8Array {
	const frame =
		'<draw:frame draw:name="Picture" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><draw:image xlink:href="Pictures/image1.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>'
	const page = (name: string, picture: boolean): string =>
		`<draw:page draw:name="${name}" draw:master-page-name="M">${picture ? frame : ""}<draw:frame draw:name="T" svg:x="1cm" svg:y="4cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>${name}</text:p></draw:text-box></draw:frame></draw:page>`

	return odpBytes({
		body: page("One", true) + page("Two", shared),
		extra: [{ name: "Pictures/image1.png", data: IMAGE, mediaType: "image/png" }]
	})
}

async function entries(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, Uint8Array>()

	for (const entry of zip.entries) out.set(entry.name, await zip.read(entry))

	return out
}

const text = (files: Map<string, Uint8Array>, name: string): string => new TextDecoder().decode(files.get(name) ?? new Uint8Array(0))
const IMAGE_NAME: Readonly<Record<Format, string>> = { pptx: "ppt/media/image1.png", odp: "Pictures/image1.png" }

const pictureOf = (node: SlideNode | undefined): ShapeNode | undefined => node?.shapes.find(shape => shape.kind === "pic")

describe("a source picture deleted", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: its image leaves the file with the save; an undo after it brings the picture back`, async () => {
			const d = await reopened(format === "pptx" ? pptx(false) : odp(false), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const picture = pictureOf(d.session.deck.nodes.get(slide)) as ShapeNode

			expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [picture.id] })).ok).toBe(true)

			const deleted = await d.save()

			expect(deleted.result.kind).toBe("written")

			const files = await entries(deleted.bytes as Uint8Array)

			expect(files.has(IMAGE_NAME[format])).toBe(false)

			if (format === "pptx") {
				expect(text(files, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("image1.png")
				expect(text(files, "[Content_Types].xml")).not.toContain("image1.png")
				expect(await danglingReferences(deleted.bytes as Uint8Array)).toEqual([])
			} else expect(text(files, "META-INF/manifest.xml")).not.toContain("Pictures/image1.png")

			expect(await modelVsFile(d, deleted.bytes as Uint8Array, format)).toBe("")
			expect((await d.undo()).ok).toBe(true)

			// Shown again before any save: its bytes are the session's.
			// (A pptx picture is drawn from its markup, its blip's relationship resolved by the renderer; an ODP one names
			// its entry.)
			const fill = pictureOf(d.session.deck.nodes.get(slide))?.props?.fill
			const part =
				fill !== undefined && fill !== "none" && fill.kind === "picture" && fill.part !== undefined
					? fill.part
					: `/${IMAGE_NAME[format]}`

			expect(pictureOf(d.session.deck.nodes.get(slide))).toBeDefined()
			expect((await readImage(d.session, part))?.bytes).toEqual(IMAGE)

			const undone = await d.save()

			expect(undone.result.kind).toBe("written")

			const back = await entries(undone.bytes as Uint8Array)
			const image = [...back].find(([name]) => /(?:ppt\/media|Pictures)\//u.test(name))

			expect(image?.[1]).toEqual(IMAGE)
			if (format === "pptx") expect(await danglingReferences(undone.bytes as Uint8Array)).toEqual([])
			expect(await modelVsFile(d, undone.bytes as Uint8Array, format)).toBe("")

			// Redone: it leaves the file again.
			expect((await d.redo()).ok).toBe(true)

			const redone = await d.save()

			expect(redone.result.kind).toBe("written")
			expect([...(await entries(redone.bytes as Uint8Array)).keys()].filter(name => /(?:ppt\/media|Pictures)\//u.test(name))).toEqual(
				[]
			)
			expect((await d.undo()).ok).toBe(true)
			expect((await d.save()).result.kind).toBe("written")

			const again = await reopened(undone.bytes as Uint8Array, format)
			const ref = again.session.deck.slides[0] as SlideRef

			await review(again.context, ref)
			expect(pictureOf(again.session.deck.nodes.get(ref))).toBeDefined()
			expect((await again.save()).result.kind).toBe("unchanged")
		})

		it(`${format}: an image another slide still shows stays`, async () => {
			const d = await reopened(format === "pptx" ? pptx(true) : odp(true), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const picture = pictureOf(d.session.deck.nodes.get(slide)) as ShapeNode

			expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [picture.id] })).ok).toBe(true)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect((await entries(saved.bytes as Uint8Array)).get(IMAGE_NAME[format])).toEqual(IMAGE)
			expect(await modelVsFile(d, saved.bytes as Uint8Array, format)).toBe("")
		})

		it(`${format}: a save with no picture deleted is unchanged, and an edit leaves the image as it was`, async () => {
			const d = await reopened(format === "pptx" ? pptx(false) : odp(false), format)

			expect((await d.save()).result.kind).toBe("unchanged")

			const slide = d.session.deck.slides[1] as SlideRef

			expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect((await entries(saved.bytes as Uint8Array)).get(IMAGE_NAME[format])).toEqual(IMAGE)
		})
	}
})

// An embedded object of an ODP deck (a chart, an OLE object) deleted: its whole Object N/ folder and its
// ObjectReplacements image leave the file with their manifest entries, and an undo after that save puts every entry
// back byte for byte.
const ODP_THUMBNAIL = "Thumbnails/thumbnail.png"

describe("a source embedded object deleted (ODP)", () => {
	for (const name of ["odftk__Presentation1_INVALID.odp", "lo__BarChartVeryLongLabel.odp"]) {
		const path = join(CORPUS_DIR, "odp", name)

		it.skipIf(!existsSync(path))(`${name}: its folder and replacement image leave the file; an undo brings them back`, async () => {
			const source = new Uint8Array(readFileSync(path))
			const before = await entries(source)
			const d = await reopened(source, "odp")
			let target: { slide: SlideRef; id: number } | undefined

			for (const slide of d.session.deck.slides) {
				await review(d.context, slide)

				const frame = d.session.deck.nodes.get(slide)?.shapes.find(shape => shape.kind === "frame" && shape.frame?.kind !== "table")

				if (frame !== undefined) {
					target = { slide, id: frame.id }
					break
				}
			}

			expect(target).toBeDefined()

			const { slide, id } = target as { slide: SlideRef; id: number }

			expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [id] })).ok).toBe(true)

			const deleted = await d.save()

			expect(deleted.result.kind).toBe("written")

			const after = await entries(deleted.bytes as Uint8Array)
			// The first page's preview is stale once content.xml is rewritten, so the save drops it (ODF 1.3 Part 2 §3.8)
			// and nothing brings it back.
			const gone = [...before.keys()].filter(entry => !after.has(entry) && entry !== ODP_THUMBNAIL)

			expect(after.has(ODP_THUMBNAIL)).toBe(false)
			const folder = gone.find(entry => /^Object [^/]+\/$|^Object [^/]+\/content\.xml$/u.test(entry))?.split("/")[0] ?? ""

			expect(folder).not.toBe("")
			if (before.has(`ObjectReplacements/${folder}`)) expect(gone).toContain(`ObjectReplacements/${folder}`)
			expect([...after.keys()].filter(entry => entry.startsWith(`${folder}/`))).toEqual([])
			expect(text(after, "META-INF/manifest.xml")).not.toContain(`"${folder}/`)
			expect(text(after, "META-INF/manifest.xml")).not.toContain(`"ObjectReplacements/${folder}"`)
			expect(await modelVsFile(d, deleted.bytes as Uint8Array, "odp")).toBe("")
			expect((await d.undo()).ok).toBe(true)

			const undone = await d.save()

			expect(undone.result.kind).toBe("written")

			const back = await entries(undone.bytes as Uint8Array)

			for (const entry of gone) expect(back.get(entry), entry).toEqual(before.get(entry))
			expect(await modelVsFile(d, undone.bytes as Uint8Array, "odp")).toBe("")
		})
	}
})
