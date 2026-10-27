import { describe, expect, it } from "vitest"
import { bytesSource, crc32, type ByteSource, ZipArchive, type ZipEntry } from "@filen/office/core/opc"
import { insertedMediaContent, insertedMediaWritten, mediaPlayback, registerInsertedMedia } from "../core/presentation/edit/apply/media"
import { insertedImage, insertedImageWritten } from "../core/presentation/edit/apply/picture"
import type { DeckOp, FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, Xfrm } from "../core/presentation/model"
import { diagramOutline, type DiagramOutlineNode } from "../core/smartart/edit"
import { mediaCapability } from "../dom/presentation/engine/media"
import { parseXml } from "../core/xml/index"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { changes, odpApplier, openOdpDeck, saveDeck, shapeNamed, slideAt } from "./odpWriteFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"

// Inserted media, pictures and diagrams across saves through the engine (save, upload, commit, rebase): a later save
// of their slide relates what the first one wrote instead of writing it again, nothing is read from the device or
// drive again, and the registries let go of what the saved file now holds.

const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
const MOVED: Xfrm = { x: 7000, y: 100_000, cx: 3_000_000, cy: 500_000, rot: 0, flipH: false, flipV: false }

function mp4(size: number, seed = 7): Uint8Array {
	const bytes = new Uint8Array(size)
	let state = seed

	for (let k = 0; k < size; k++) {
		state = (state * 1_103_515_245 + 12_345) >>> 0
		bytes[k] = state >>> 24
	}

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

function deviceFile(bytes: Uint8Array, reads: { bytes: number }): FileLike {
	return {
		size: bytes.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = bytes.length) => ({
			arrayBuffer: () => {
				reads.bytes += end - start

				return Promise.resolve(bytes.slice(start, end).buffer)
			}
		})
	}
}

function deckOf(format: "odp" | "pptx"): Uint8Array {
	return format === "odp"
		? odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Media</text:p></draw:text-box></draw:frame></draw:page>'
			})
		: buildPptx({
				slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Media"))) }]
			})
}

async function entries(bytes: Uint8Array | undefined): Promise<ZipArchive> {
	if (bytes === undefined) throw new Error("no saved file")

	return ZipArchive.open(bytesSource(bytes))
}

async function entryText(archive: ZipArchive, name: string): Promise<string> {
	const entry = archive.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return new TextDecoder().decode(await archive.read(entry))
}

// The other shape of the slide (a text box), moved: its slide is written again.
function moveOther(slide: SlideNode, except: number): DeckOp {
	const other = slide.shapes.find(shape => shape.id !== except) as ShapeNode

	return { family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: other.id }, xfrm: MOVED }
}

async function written(save: () => Promise<{ readonly result: { readonly kind: string }; readonly bytes: Uint8Array | undefined }>) {
	const saved = await save()

	expect(saved.result.kind).toBe("written")

	return saved.bytes
}

describe("an inserted medium saved, then its slide saved again", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: relates the medium the first save wrote, reading nothing from the device again`, async () => {
			const video = mp4(400_000)
			const reads = { bytes: 0 }
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideNode["ref"]
			const registered = await mediaCapability.registerMedia(d.context, { kind: "file", file: deviceFile(video, reads) })

			if ("reason" in registered) throw new Error(registered.reason)

			const media: InsertedMedia = { ...registered, poster: image(16, 9), durationMs: 1000 }
			const shape = { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode
			const inserted = await d.command({ family: "media", kind: "insert", slide, shape, media })

			expect(inserted.ok).toBe(true)

			const first = await entries(await written(d.save))
			const afterFirst = reads.bytes
			const node = d.session.deck.nodes.get(slide) as SlideNode
			const medium = node.shapes.find(each => each.name === "clip.mp4") as ShapeNode

			// The registry let go of the device file: the medium is the part the save wrote.
			expect(insertedMediaWritten(d.session.deck, registered.id)).toBeDefined()
			expect((await d.command(moveOther(node, medium.id))).ok).toBe(true)

			const second = await entries(await written(d.save))
			const mediaEntries = second.entries.map(entry => entry.name).filter(name => /\.mp4$/u.test(name))
			const posters = second.entries.map(entry => entry.name).filter(name => /\.png$/u.test(name))

			expect(mediaEntries).toEqual(first.entries.map(entry => entry.name).filter(name => /\.mp4$/u.test(name)))
			expect(mediaEntries).toHaveLength(1)
			expect(posters).toHaveLength(1)
			expect(reads.bytes - afterFirst).toBe(0)

			if (format === "pptx") {
				const rels = await entryText(second, "ppt/slides/_rels/slide1.xml.rels")

				// The a:videoFile link and the p14:media embed, each once.
				expect(rels.match(/media1\.mp4/gu)).toHaveLength(2)
				expect(rels.match(/\.png"/gu)).toHaveLength(1)
			} else {
				const content = await entryText(second, "content.xml")

				expect(content.match(/<draw:plugin /gu)).toHaveLength(1)
				expect(content).toContain(`xlink:href="${mediaEntries[0] ?? ""}"`)
			}
		})
	}

	it("lets go of a drive medium's range source once the save that wrote it commits", async () => {
		const video = mp4(300_000)
		const d = await driveSession(deckOf("pptx"), "pptx")
		const closed = { count: 0 }
		const deckRange = d.session.rangeSource

		d.drive.files.set("clip", video)
		;(d.session as { rangeSource: typeof deckRange }).rangeSource = spec => {
			if ((spec.port as unknown as { uuid: string }).uuid !== "clip") return (deckRange as NonNullable<typeof deckRange>)(spec)

			const source: ByteSource & { close(): void } = {
				size: video.length,
				read: (offset, length) => Promise.resolve(video.slice(offset, offset + length)),
				close: () => {
					closed.count++
				}
			}

			return source
		}

		const registered = await mediaCapability.registerMedia(d.context, {
			kind: "range",
			port: { uuid: "clip", postMessage: () => undefined, close: () => undefined } as never,
			size: video.length,
			checked: false,
			name: "clip.mp4",
			type: "video/mp4"
		})

		if ("reason" in registered) throw new Error(registered.reason)

		const slide = d.session.deck.slides[0] as SlideNode["ref"]
		const shape = { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

		expect(
			(await d.command({ family: "media", kind: "insert", slide, shape, media: { ...registered, poster: image(16, 9) } })).ok
		).toBe(true)
		expect(closed.count).toBe(0)

		await written(d.save)

		expect(closed.count).toBe(1)
		// A conversion still reads it, now from the saved package.
		expect(insertedMediaContent(d.session.deck, registered.id)?.size).toBe(video.length)
	})
})

describe("an inserted picture saved, then edited and saved again", () => {
	for (const format of ["pptx", "odp"] as const) {
		for (const edit of ["crop", "move", "otherShape"] as const) {
			it(`${format}, ${edit}: one image entry, and the registry holds no bytes of it`, async () => {
				const d = await driveSession(deckOf(format), format)
				const slide = d.session.deck.slides[0] as SlideNode["ref"]
				const shape = { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

				expect((await d.command({ family: "picture", kind: "insert", slide, shape, image: image(64, 32) })).ok).toBe(true)
				await written(d.save)

				const node = d.session.deck.nodes.get(slide) as SlideNode
				const picture = node.shapes.find(each => each.name === "Picture") as ShapeNode
				const fill = picture.props?.fill
				const id = fill !== undefined && fill !== "none" && fill.kind === "picture" ? (fill.inserted ?? 0) : 0

				expect(insertedImage(d.session.deck, id)).toBeUndefined()
				expect(insertedImageWritten(d.session.deck, id)?.part).toBeDefined()

				const op: DeckOp =
					edit === "crop"
						? { family: "picture", kind: "crop", target: { slide, id: picture.id }, crop: { l: 10_000, t: 0, r: 0, b: 0 } }
						: edit === "move"
							? { family: "shape", kind: "setXfrm", target: { slide, id: picture.id }, xfrm: { ...BOX, x: 9000 } }
							: moveOther(node, picture.id)

				expect((await d.command(op)).ok).toBe(true)

				const second = await entries(await written(d.save))

				expect(second.entries.map(entry => entry.name).filter(name => /\.png$/u.test(name))).toHaveLength(1)
			})
		}
	}
})

describe("an inserted diagram saved, then edited and saved again", () => {
	it("edits the parts the first save wrote instead of adding them again", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideNode["ref"]
		const inserted = await d.command({
			family: "smartart",
			kind: "insert",
			slide,
			shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: { ...BOX, y: 2_000_000 } } as ShapeNode,
			layout: { uniqueId: "urn:filen:smartart:layout:column", source: "gallery" },
			texts: ["Alpha", "Beta"]
		})

		expect(inserted.ok).toBe(true)

		const diagrams = (archive: ZipArchive): string[] =>
			archive.entries.map(entry => entry.name).filter(name => name.startsWith("ppt/diagrams/") && !name.includes("_rels"))
		const firstFile = await entries(await written(d.save))
		const first = diagrams(firstFile)
		const node = d.session.deck.nodes.get(slide) as SlideNode
		const frame = node.shapes.find(each => each.name === "Diagram")
		const data = frame?.frame?.kind === "smartart" ? frame.frame.data : ""

		expect(data.startsWith("/ppt/diagrams/")).toBe(true)

		const outline = diagramOutline(
			parseXml(await firstFile.read(firstFile.get(data.slice(1)) as ZipEntry))
		) as readonly DiagramOutlineNode[]
		const alpha = outline.find(each => each.text === "Alpha")?.id ?? ""
		const target = { slide, id: frame?.id ?? 0 }

		expect((await d.command({ family: "smartart", kind: "setNodeText", target, node: alpha, text: "Omega" })).ok).toBe(true)

		const second = diagrams(await entries(await written(d.save)))

		expect(second).toEqual(first)

		// And a save of the slide that leaves the diagram alone writes none of its parts.
		expect((await d.command(moveOther(d.session.deck.nodes.get(slide) as SlideNode, target.id))).ok).toBe(true)
		expect(diagrams(await entries(await written(d.save)))).toEqual(first)
	})
})

describe("ODP media names", () => {
	async function insertAndSave(bytes: Uint8Array, video: Uint8Array, name: string): Promise<Uint8Array> {
		const opened = await openOdpDeck(bytes)
		const apply = odpApplier(opened)

		// A new session's registry counts from 1 again.
		registerInsertedMedia(opened.deck, 1, {
			bytes: {
				length: video.length,
				chunks: async function* () {
					yield await Promise.resolve(video)
				}
			},
			size: video.length,
			crc32: crc32(video),
			contentType: "video/mp4",
			name
		})

		const media: InsertedMedia = {
			id: 1,
			kind: "video",
			contentType: "video/mp4",
			size: video.length,
			crc32: crc32(video),
			poster: image(16, 9)
		}
		const shape = { id: 0, name, hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

		expect(apply({ family: "media", kind: "insert", slide: slideAt(opened, 0).ref, shape, media })).toBeUndefined()

		const { outcome, bytes: saved } = await saveDeck(opened, changes())

		expect(outcome).toMatchObject({ kind: "written" })

		return saved
	}

	it("gives a medium inserted in a later session a name the package does not hold", async () => {
		const first = mp4(200_000, 5)
		const second = mp4(150_000, 9)
		const once = await insertAndSave(deckOf("odp"), first, "a.mp4")
		const twice = await entries(await insertAndSave(once, second, "b.mp4"))
		const media = twice.entries.filter(entry => entry.name.startsWith("Media/"))
		const posters = twice.entries.filter(entry => entry.name.startsWith("Pictures/"))

		expect(media.map(entry => entry.crc32).sort()).toEqual([crc32(first), crc32(second)].sort())
		expect(new Set(media.map(entry => entry.name)).size).toBe(2)
		expect(new Set(posters.map(entry => entry.name)).size).toBe(2)
	})
})

describe("ODP media playback", () => {
	it("writes loop, mute and volume as the plugin's parameters, never as anim:audio, and reads them back", async () => {
		const video = mp4(50_000)
		const opened = await openOdpDeck(odpBytes({ body: '<draw:page draw:name="One" draw:master-page-name="M"></draw:page>' }))
		const apply = odpApplier(opened)

		registerInsertedMedia(opened.deck, 1, {
			bytes: {
				length: video.length,
				chunks: async function* () {
					yield await Promise.resolve(video)
				}
			},
			size: video.length,
			crc32: crc32(video),
			contentType: "video/mp4",
			name: "c.mp4"
		})

		const media: InsertedMedia = {
			id: 1,
			kind: "video",
			contentType: "video/mp4",
			size: video.length,
			crc32: crc32(video),
			poster: image(16, 9)
		}
		const node = slideAt(opened, 0)

		expect(
			apply({
				family: "media",
				kind: "insert",
				slide: node.ref,
				shape: { id: 0, name: "c.mp4", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
				media
			})
		).toBeUndefined()

		const id = (slideAt(opened, 0).shapes.at(-1) as ShapeNode).id

		expect(
			apply({
				family: "media",
				kind: "setPlayback",
				target: { slide: node.ref, id },
				playback: { loop: true, mute: true, volume: 50_000 }
			})
		).toBeUndefined()

		const { bytes } = await saveDeck(opened, changes())
		const content = await entryText(await entries(bytes), "content.xml")

		expect(content).toContain('draw:name="Loop" draw:value="true"')
		expect(content).toContain('draw:name="Mute" draw:value="true"')
		expect(content).toContain('draw:name="VolumeDB" draw:value="-6"')
		expect(content).not.toContain("anim:audio")

		const reopened = await openOdpDeck(bytes)
		const slide = slideAt(reopened, 0)
		const again = shapeNamed(slide, "c.mp4")

		expect(mediaPlayback(slide.timing, again.id)).toEqual({ loop: true, mute: true, volume: 50_119 })
		// The file's own plugin is spliced as its source: changing it is refused, never dropped.
		expect(
			odpApplier(reopened)({
				family: "media",
				kind: "setPlayback",
				target: { slide: slide.ref, id: again.id },
				playback: { loop: false }
			})
		).toMatchObject({
			reason: "notImplemented"
		})
	})
})

describe("an insert undone past a save and redone", () => {
	for (const [format, kind] of [
		["pptx", "picture"],
		["pptx", "media"],
		["pptx", "smartart"],
		["odp", "picture"],
		["odp", "media"]
	] as const) {
		it(`${format} ${kind}: names what the first save wrote instead of writing it again`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideNode["ref"]
			const shape = { id: 0, name: kind, hidden: false, kind: kind === "smartart" ? "frame" : "pic", xfrm: BOX } as ShapeNode
			let op: DeckOp

			if (kind === "picture") op = { family: "picture", kind: "insert", slide, shape, image: image(64, 32) }
			else if (kind === "smartart")
				op = {
					family: "smartart",
					kind: "insert",
					slide,
					shape,
					layout: { uniqueId: "urn:filen:smartart:layout:column", source: "gallery" },
					texts: ["Alpha", "Beta"]
				}
			else {
				const registered = await mediaCapability.registerMedia(d.context, {
					kind: "file",
					file: deviceFile(mp4(200_000), { bytes: 0 })
				})

				if ("reason" in registered) throw new Error(registered.reason)

				op = { family: "media", kind: "insert", slide, shape, media: { ...registered, poster: image(16, 9) } }
			}

			expect((await d.command(op)).ok).toBe(true)

			const assets = (archive: ZipArchive): string[] =>
				archive.entries
					.map(entry => entry.name)
					.filter(name => /media|Media|Pictures|diagrams/u.test(name) && !name.includes("_rels"))
			const first = assets(await entries(await written(d.save)))

			expect((await d.undo()).ok).toBe(true)
			await written(d.save)
			expect((await d.redo()).ok).toBe(true)
			expect(assets(await entries(await written(d.save)))).toEqual(first)
		})
	}
})
