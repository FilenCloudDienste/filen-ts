import { describe, expect, it } from "vitest"
import { bytesSource, crc32, ZipArchive } from "@filen/office/core/opc"
import { mediaPlayback, registerInsertedMedia } from "../core/presentation/edit/apply/media"
import type { FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import type { ShapeNode } from "../core/presentation/model"
import { mediaCapability } from "../dom/presentation/engine/media"
import { viewCapability } from "../dom/presentation/engine/view"
import { selectionKinds, slideShapes } from "../react/presentation/edit/selection"
import { odpBytes } from "./odpFixtures"
import { changes, entriesOf, odpApplier, openOdpDeck, saveDeck, shapeNamed, slideAt, text as odpText } from "./odpWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"
import { openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"

// Inserted media saved: a stored entry streamed from where the worker registered it, read once, carrying the CRC-32
// taken at insert (a file changed since fails the save); pptx relates it as a:videoFile and p14:media with its poster as
// the picture fill, ODP writes a draw:plugin with its manifest entry. Playback options save as the timing's media node.
// The render says a layer plays a medium, so the editor shows the Video or Audio tab.

function mp4(size: number, seed = 1): Uint8Array {
	const bytes = new Uint8Array(size)
	let state = seed

	for (let k = 0; k < size; k++) {
		state = (state * 1_103_515_245 + 12_345) >>> 0
		bytes[k] = state >>> 24
	}

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

interface Reads {
	count: number
	bytes: number
}

// A file whose bytes can change after it was registered (the device file edited meanwhile).
function fileLike(holder: { bytes: Uint8Array }, reads: Reads): FileLike {
	return {
		get size() {
			return holder.bytes.length
		},
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = holder.bytes.length) => ({
			arrayBuffer: () => {
				reads.count++
				reads.bytes += end - start

				return Promise.resolve(holder.bytes.slice(start, end).buffer)
			}
		})
	}
}

function plainDeck(): Uint8Array {
	return buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Media"))) }] })
}

const BOX = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }

function videoShape(): ShapeNode {
	return { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX, alt: { descr: "clip.mp4" } }
}

async function insertVideo(holder: { bytes: Uint8Array }, reads: Reads): Promise<{ h: EditHarness; revision: number; id: number }> {
	const h = await editHarness(plainDeck())
	const context = { ...h.context, lane: "background" as const }
	const registered = await mediaCapability.registerMedia(context, { kind: "file", file: fileLike(holder, reads) })

	if ("reason" in registered) throw new Error(registered.reason)

	const media: InsertedMedia = { ...registered, poster: image(16, 9), durationMs: 1000 }
	const result = await h.command({
		family: "media",
		kind: "insert",
		slide: h.session.deck.slides[0] as never,
		shape: videoShape(),
		media
	})

	if (!result.ok) throw new Error(result.refusal)

	const shapes = (await h.slide(0)).shapes

	return { h, revision: result.revision, id: (shapes[shapes.length - 1] as ShapeNode).id }
}

describe("inserted media in pptx", () => {
	it("saves a stored entry read once with the CRC its header carries, related as a:videoFile and p14:media", async () => {
		const holder = { bytes: mp4(2_500_000) }
		const reads = { count: 0, bytes: 0 }
		const { h, revision } = await insertVideo(holder, reads)
		const atInsert = reads.bytes

		expect(atInsert).toBe(holder.bytes.length)

		const saved = await saveEdits(h, revision)

		// Once more at save, and no more.
		expect(reads.bytes - atInsert).toBe(holder.bytes.length)

		const archive = await ZipArchive.open(bytesSource(saved))
		const entry = archive.get("ppt/media/media1.mp4")

		expect(entry?.method).toBe(0)
		expect(entry?.crc32).toBe(crc32(holder.bytes))

		const parts = await partsOf(saved)
		const rels = text(parts.get("ppt/slides/_rels/slide1.xml.rels"))
		const slide = text(parts.get("ppt/slides/slide1.xml"))

		expect(rels).toMatch(/relationships\/video" Target="\.\.\/media\/media1\.mp4"/u)
		expect(rels).toMatch(/2007\/relationships\/media" Target="\.\.\/media\/media1\.mp4"/u)
		expect(rels).toMatch(/relationships\/image" Target="\.\.\/media\/image\d+\.png"/u)
		expect(slide).toMatch(/<a:videoFile r:link="rId\d+"\/>/u)
		expect(slide).toContain('<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId')
		expect(text(parts.get("[Content_Types].xml"))).toMatch(/video\/mp4/u)

		const reopened = await openDeck(saved)
		const shape = slideNode(reopened, 0).shapes.find(candidate => candidate.name === "clip.mp4")

		expect(shape?.media).toMatchObject({
			kind: "video",
			part: "/ppt/media/media1.mp4",
			contentType: "video/mp4",
			size: holder.bytes.length
		})
		expect(shape?.xfrm).toMatchObject({ x: BOX.x, y: BOX.y, cx: BOX.cx, cy: BOX.cy })
	})

	it("stores a medium two slides play once, a duplicate made before the save relating the same part", async () => {
		const holder = { bytes: mp4(300_000) }
		const reads = { count: 0, bytes: 0 }
		const { h } = await insertVideo(holder, reads)
		const duplicated = await h.command({ family: "slide", kind: "duplicate", slide: h.session.deck.slides[0] as never })

		if (!duplicated.ok) throw new Error(duplicated.refusal)

		const atInsert = reads.bytes
		const saved = await saveEdits(h, duplicated.revision)
		const parts = await partsOf(saved)

		expect([...parts.keys()].filter(name => name.startsWith("ppt/media/") && name.endsWith(".mp4"))).toEqual(["ppt/media/media1.mp4"])
		expect(reads.bytes - atInsert).toBe(holder.bytes.length)

		for (const rels of ["ppt/slides/_rels/slide1.xml.rels", "ppt/slides/_rels/slide2.xml.rels"]) {
			expect(text(parts.get(rels))).toMatch(/relationships\/video" Target="\.\.\/media\/media1\.mp4"/u)
			expect(text(parts.get(rels))).toMatch(/2007\/relationships\/media" Target="\.\.\/media\/media1\.mp4"/u)
		}
	})

	it("fails the save when the file changed after the insert", async () => {
		const holder = { bytes: mp4(600_000) }
		const { h, revision } = await insertVideo(holder, { count: 0, bytes: 0 })
		const changed = holder.bytes.slice()

		changed[300_000] = (changed[300_000] ?? 0) ^ 0xff
		holder.bytes = changed

		await expect(saveEdits(h, revision)).rejects.toThrow()
	})

	it("saves playback options as the timing's media node", async () => {
		const { h, id } = await insertVideo({ bytes: mp4(100_000) }, { count: 0, bytes: 0 })
		const target = { slide: h.session.deck.slides[0] as never, id }
		const result = await h.command({
			family: "media",
			kind: "setPlayback",
			target,
			playback: { volume: 50_000, loop: true, hideWhenStopped: true }
		})

		if (!result.ok) throw new Error(result.refusal)

		const saved = await saveEdits(h, result.revision)
		const slide = text((await partsOf(saved)).get("ppt/slides/slide1.xml"))

		expect(slide).toMatch(
			/<p:video><p:cMediaNode vol="50000" showWhenStopped="0"><p:cTn id="\d+" repeatCount="indefinite" fill="hold"/u
		)

		const reopened = await openDeck(saved)
		const node = slideNode(reopened, 0)
		const shape = node.shapes.find(candidate => candidate.name === "clip.mp4")

		expect(mediaPlayback(node.timing, shape?.id ?? -1)).toEqual({ volume: 50_000, loop: true, hideWhenStopped: true })
	})

	it("renders the inserted video as a layer that plays it, which the editor selects as a video", async () => {
		const { h, id } = await insertVideo({ bytes: mp4(100_000) }, { count: 0, bytes: 0 })
		const [render] = await viewCapability.render(h.context, [h.session.deck.slides[0] as never])

		if (render === undefined) throw new Error("no render")

		const layer = render.layers.find(candidate => candidate.box?.id === id)

		expect(layer?.media).toMatchObject({ kind: "video", part: "inserted:1", contentType: "video/mp4" })
		expect(render.layers.filter(candidate => candidate.media !== undefined)).toHaveLength(1)

		const shape = slideShapes(render).find(candidate => candidate.id === id)

		expect(shape === undefined ? [] : [...selectionKinds([shape])]).toEqual(["video"])
	})
})

const P14_NS = "http://schemas.microsoft.com/office/powerpoint/2010/main"
const VIDEO_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"
const MEDIA_REL = "http://schemas.microsoft.com/office/2007/relationships/media"

// A deck whose slide holds a source video (shape 4) trimmed by its p14:media.
function sourceVideoDeck(): Uint8Array {
	const pic =
		'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Video 4"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId10"/>' +
		`<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="${P14_NS}" r:embed="rId11"><p14:trim st="1500" end="250"/></p14:media></p:ext></p:extLst></p:nvPr></p:nvPicPr>` +
		'<p:blipFill><a:blip r:embed="rId12"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
		'<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Media"))) + pic,
				rels: [
					["rId10", VIDEO_REL, "../media/media1.mp4"],
					["rId11", MEDIA_REL, "../media/media1.mp4"],
					["rId12", "image", "../media/image1.png"]
				]
			}
		],
		parts: {
			"ppt/media/media1.mp4": { data: mp4(4096), type: "video/mp4" },
			"ppt/media/image1.png": { data: image().bytes, type: "image/png" }
		}
	})
}

const NEW_BOX: ShapeNode = {
	id: 0,
	name: "Box",
	hidden: false,
	kind: "sp",
	xfrm: { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false },
	props: { geometry: { kind: "preset", preset: "rect", guides: [] } }
}

describe("source media timing in pptx", () => {
	it("keeps a trim when the same save also inserts a shape on the slide", async () => {
		const h = await editHarness(sourceVideoDeck())
		const slide = h.session.deck.slides[0] as never

		expect((await h.command({ family: "mediaTiming", kind: "setTrim", target: { slide, id: 4 }, startMs: 2000, endMs: 500 })).ok).toBe(
			true
		)

		const added = await h.command({ family: "shape", kind: "insert", slide, shape: NEW_BOX })

		if (!added.ok) throw new Error(added.refusal)

		const reopened = await openDeck(await saveEdits(h, added.revision))

		expect(slideNode(reopened, 0).shapes.find(shape => shape.name === "Video 4")?.media?.timing).toEqual({
			trim: { startMs: 2000, endMs: 500 }
		})
	})

	it("keeps a trim made on a duplicated slide", async () => {
		const h = await editHarness(sourceVideoDeck())

		expect((await h.command({ family: "slide", kind: "duplicate", slide: h.session.deck.slides[0] as never })).ok).toBe(true)

		const copy = (await h.slide(1)).shapes.find(shape => shape.name === "Video 4")
		const trimmed = await h.command({
			family: "mediaTiming",
			kind: "setTrim",
			target: { slide: h.session.deck.slides[1] as never, id: copy?.id ?? -1 },
			startMs: 3000,
			endMs: 0
		})

		if (!trimmed.ok) throw new Error(trimmed.refusal)

		const reopened = await openDeck(await saveEdits(h, trimmed.revision))
		const timingAt = (index: number) => slideNode(reopened, index).shapes.find(shape => shape.name === "Video 4")?.media?.timing

		expect(timingAt(0)).toEqual({ trim: { startMs: 1500, endMs: 250 } })
		expect(timingAt(1)).toEqual({ trim: { startMs: 3000, endMs: 0 } })
	})
})

describe("inserted media in ODP", () => {
	it("writes a draw:plugin over its poster, the medium stored in Media/ with its manifest entry", async () => {
		const opened = await openOdpDeck(
			odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Media</text:p></draw:text-box></draw:frame></draw:page>'
			})
		)
		const apply = odpApplier(opened)
		const video = mp4(300_000, 5)
		const reads = { count: 0, bytes: 0 }

		registerInsertedMedia(opened.deck, 1, {
			bytes: {
				length: video.length,
				// One chunk, counted.
				chunks: async function* () {
					reads.bytes += video.length
					yield await Promise.resolve(video)
				}
			},
			size: video.length,
			crc32: crc32(video),
			contentType: "video/mp4",
			name: "clip.mp4"
		})

		const node = slideAt(opened, 0)
		const media: InsertedMedia = {
			id: 1,
			kind: "video",
			contentType: "video/mp4",
			size: video.length,
			crc32: crc32(video),
			poster: image(16, 9)
		}

		expect(apply({ family: "media", kind: "insert", slide: node.ref, shape: videoShape(), media })).toBeUndefined()

		const { outcome, bytes } = await saveDeck(opened, changes())

		expect(outcome).toMatchObject({ kind: "written" })
		expect(reads.bytes).toBe(video.length)

		const entries = await entriesOf(bytes)
		const content = odpText(entries.get("content.xml"))
		const manifest = odpText(entries.get("META-INF/manifest.xml"))
		const archive = await ZipArchive.open(bytesSource(bytes))

		expect(archive.get("Media/media1.mp4")?.method).toBe(0)
		expect(archive.get("Media/media1.mp4")?.crc32).toBe(crc32(video))
		expect(manifest).toContain('manifest:full-path="Media/media1.mp4" manifest:media-type="video/mp4"')
		expect(manifest).toMatch(/manifest:full-path="Pictures\/poster1\.png"/u)
		expect(content).toContain('<draw:plugin xlink:href="Media/media1.mp4"')
		expect(content).toContain('<draw:param draw:name="MediaMimeType" draw:value="video/mp4"/>')

		const reopened = await openOdpDeck(bytes)
		const shape = shapeNamed(slideAt(reopened, 0), "clip.mp4")

		expect(shape.media).toMatchObject({ kind: "video", part: "/Media/media1.mp4" })
		expect(shape.xfrm).toMatchObject({ x: BOX.x, y: BOX.y, cx: BOX.cx, cy: BOX.cy })
	})
})
