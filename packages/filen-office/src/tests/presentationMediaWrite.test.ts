import { describe, expect, it, vi } from "vitest"
import { bytesSource, crc32, OpcPackage, ZipArchive } from "@filen/office/core/opc"
import { DEFLATE_HELD } from "../core/opc/mediaPolicy"
import { releasedMediaBytes } from "../core/pptx/write/parts"
import { mediaPlayback, registerInsertedMedia } from "../core/presentation/edit/apply/media"
import type { FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { mediaCapability } from "../dom/presentation/engine/media"
import { review } from "../dom/presentation/engine/review"
import { viewCapability } from "../dom/presentation/engine/view"
import { selectionKinds, slideShapes } from "../react/presentation/edit/selection"
import { odpBytes } from "./odpFixtures"
import { changes, entriesOf, odpApplier, openOdpDeck, saveDeck, shapeNamed, slideAt, text as odpText } from "./odpWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { reopened } from "./modelVsFile"
import { image } from "./presentationObjectsFixtures"
import { danglingReferences, openDeck, partsOf, saveEdits, slideNode, text } from "./pptxWriteFixtures"

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
function sourceVideoDeck(video: Uint8Array = mp4(4096)): Uint8Array {
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
			"ppt/media/media1.mp4": { data: video, type: "video/mp4" },
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

const MEDIUM = "ppt/media/media1.mp4"

async function zipEntries(bytes: Uint8Array | undefined): Promise<Map<string, Uint8Array>> {
	const zip = await ZipArchive.open(bytesSource(bytes ?? new Uint8Array(0)))
	const out = new Map<string, Uint8Array>()

	for (const entry of zip.entries) out.set(entry.name, await zip.read(entry))

	return out
}

// Compared without a deep equality's per-element walk (a part over DEFLATE_HELD).
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.compare(a, b) === 0

const decoded = (files: Map<string, Uint8Array>, name: string): string => new TextDecoder().decode(files.get(name) ?? new Uint8Array(0))

// A source medium deleted: never read whole to be held for an undo. It stays in the file, unrelated, while a step the
// history holds names it; an undo relates it again with its bytes as they were, and once no step names it a save
// leaves it out.
describe("a source medium deleted in pptx", () => {
	it("stays unread in the file while the history names it, an undo relating it again", async () => {
		const video = mp4(200_000, 7)
		const d = await reopened(sourceVideoDeck(video), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [4] })).ok).toBe(true)

		const read = vi.spyOn(OpcPackage.prototype, "read")
		const deleted = await d.save().finally(() => {
			read.mockRestore()
		})

		expect(deleted.result.kind).toBe("written")
		expect(read.mock.calls.filter(([name]) => name.replace(/^\//u, "") === MEDIUM)).toEqual([])
		expect(releasedMediaBytes(d.session.deck, MEDIUM)).toBeUndefined()

		const afterDelete = await zipEntries(deleted.bytes)

		expect(afterDelete.get(MEDIUM)).toEqual(video)
		expect(decoded(afterDelete, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("media1.mp4")
		expect(decoded(afterDelete, "ppt/slides/slide1.xml")).not.toContain("<a:videoFile")

		// Another save between: the medium still stays for the undo.
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

		const between = await d.save()

		expect(between.result.kind).toBe("written")
		expect((await zipEntries(between.bytes)).get(MEDIUM)).toEqual(video)
		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)

		const undone = await d.save()

		expect(undone.result.kind).toBe("written")

		const back = await zipEntries(undone.bytes)

		expect(back.get(MEDIUM)).toEqual(video)
		expect(decoded(back, "ppt/slides/_rels/slide1.xml.rels")).toMatch(/relationships\/video" Target="\.\.\/media\/media1\.mp4"/u)
		expect(await danglingReferences(undone.bytes as Uint8Array)).toEqual([])
		expect(
			slideNode(await openDeck(undone.bytes as Uint8Array), 0).shapes.find(shape => shape.name === "Video 4")?.media
		).toMatchObject({
			kind: "video",
			part: `/${MEDIUM}`
		})
	})

	it("leaves a picture over DEFLATE_HELD unread in the file, an undo relating it again", async () => {
		const picture = new Uint8Array(DEFLATE_HELD + 4096)

		picture.set(image().bytes, 0)

		const pic =
			'<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 4"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
			'<p:blipFill><a:blip r:embed="rId12"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
			'<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="4000000" cy="3000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
		const deck = buildPptx({
			slides: [
				{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Big"))) + pic, rels: [["rId12", "image", "../media/image1.png"]] }
			],
			parts: { "ppt/media/image1.png": { data: picture, type: "image/png" } }
		})
		const PICTURE = "ppt/media/image1.png"
		const d = await reopened(deck, "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [4] })).ok).toBe(true)

		const read = vi.spyOn(OpcPackage.prototype, "read")
		const deleted = await d.save().finally(() => {
			read.mockRestore()
		})

		expect(deleted.result.kind).toBe("written")
		expect(read.mock.calls.filter(([name]) => name.replace(/^\//u, "") === PICTURE)).toEqual([])
		expect(releasedMediaBytes(d.session.deck, PICTURE)).toBeUndefined()

		const afterDelete = await zipEntries(deleted.bytes)

		expect(sameBytes(afterDelete.get(PICTURE), picture)).toBe(true)
		expect(decoded(afterDelete, "ppt/slides/_rels/slide1.xml.rels")).not.toContain("image1.png")

		// Another save between: the session prune keeps the part for the undo.
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

		const between = await d.save()

		expect(between.result.kind).toBe("written")
		expect(sameBytes((await zipEntries(between.bytes)).get(PICTURE), picture)).toBe(true)
		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)

		const undone = await d.save()

		expect(undone.result.kind).toBe("written")

		const back = await zipEntries(undone.bytes)

		expect(sameBytes(back.get(PICTURE), picture)).toBe(true)
		expect(decoded(back, "ppt/slides/_rels/slide1.xml.rels")).toMatch(/Id="rId12"[^>]*Target="\.\.\/media\/image1\.png"/u)
		expect(await danglingReferences(undone.bytes as Uint8Array)).toEqual([])
	})

	it("keeps a medium the held markup names only by relationship id, an undo relating it again", async () => {
		const sound = mp4(2048, 3)
		const SOUND = "ppt/media/audio1.wav"
		const button =
			'<p:sp><p:nvSpPr><p:cNvPr id="5" name="Button 5"><a:hlinkClick r:id="" action="ppaction://noaction">' +
			'<a:snd r:embed="rId20" name="click.wav"/></a:hlinkClick></p:cNvPr><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
			'<p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:sp>'
		const deck = buildPptx({
			slides: [
				{
					shapes: sp(2, "Title 1", 'type="title"', "", body(para("Sound"))) + button,
					rels: [["rId20", "audio", "../media/audio1.wav"]]
				}
			],
			parts: { [SOUND]: { data: sound, type: "audio/wav" } }
		})
		const d = await reopened(deck, "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [5] })).ok).toBe(true)

		const deleted = await d.save()

		expect(deleted.result.kind).toBe("written")
		expect(sameBytes((await zipEntries(deleted.bytes)).get(SOUND), sound)).toBe(true)
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

		const between = await d.save()

		expect(between.result.kind).toBe("written")
		expect(sameBytes((await zipEntries(between.bytes)).get(SOUND), sound)).toBe(true)
		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)

		const undone = await d.save()

		expect(undone.result.kind).toBe("written")

		const back = await zipEntries(undone.bytes)

		expect(sameBytes(back.get(SOUND), sound)).toBe(true)
		expect(decoded(back, "ppt/slides/_rels/slide1.xml.rels")).toMatch(/Id="rId20"[^>]*Target="\.\.\/media\/audio1\.wav"/u)
		expect(await danglingReferences(undone.bytes as Uint8Array)).toEqual([])

		// Deleted again and saved, then nothing left to undo it: the next save leaves it out.
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [5] })).ok).toBe(true)
		expect(sameBytes((await zipEntries((await d.save()).bytes)).get(SOUND), sound)).toBe(true)
		sessionEdits(d.session).history.clear()
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

		const pruned = await d.save()

		expect(pruned.result.kind).toBe("written")

		const files = await zipEntries(pruned.bytes)

		expect(files.has(SOUND)).toBe(false)
		expect(decoded(files, "[Content_Types].xml")).not.toContain("audio1.wav")
		expect(await danglingReferences(pruned.bytes as Uint8Array)).toEqual([])
	})

	it("leaves the file once no step the history holds names it", async () => {
		const d = await reopened(sourceVideoDeck(), "pptx")
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)
		expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [4] })).ok).toBe(true)
		expect((await zipEntries((await d.save()).bytes)).has(MEDIUM)).toBe(true)

		sessionEdits(d.session).history.clear()
		expect((await d.command({ family: "slide", kind: "hide", slides: [slide], hidden: true })).ok).toBe(true)

		const pruned = await d.save()

		expect(pruned.result.kind).toBe("written")

		const files = await zipEntries(pruned.bytes)

		expect(files.has(MEDIUM)).toBe(false)
		expect(decoded(files, "[Content_Types].xml")).not.toContain("media1.mp4")
		expect(await danglingReferences(pruned.bytes as Uint8Array)).toEqual([])
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
