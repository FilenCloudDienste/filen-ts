import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { crc32, ZipArchive, bytesSource } from "@filen/office/core/opc"
import { mediaPlayback } from "../core/presentation/edit/apply/media"
import type { FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import type { ShapeNode } from "../core/presentation/model"
import type { CallSignal, EngineSession, MediaPortServer, Task } from "../dom/presentation/engine"
import { mediaCapability } from "../dom/presentation/engine/media"
import { viewCapability } from "../dom/presentation/engine/view"
import { indexesOver } from "../dom/presentation/media"
import type { MediaRefusal, PortLike, PortStreamMeta, PresentationEvent } from "../dom/presentation/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"

// Media served by range from the deck's package or a registered file: a stored entry where the zip has it, a
// deflated one only once its inflate index is built (meanwhile "preparing" with progress notices), an inserted
// medium from where it was registered; nothing that is not a medium a shape plays.

// Bytes an ISO BMFF sniff recognises (ftyp first), then noise.
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

const VIDEO_PIC = (id: number, video: string, media: string, poster: string): string =>
	`<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="Video ${String(id)}"/><p:cNvPicPr/><p:nvPr><a:videoFile r:link="${video}"/>` +
	`<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="${media}"/></p:ext></p:extLst></p:nvPr></p:nvPicPr>` +
	`<p:blipFill><a:blip r:embed="${poster}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
	'<p:spPr><a:xfrm><a:off x="100" y="100"/><a:ext cx="4000" cy="3000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

const VIDEO = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"
const MEDIA = "http://schemas.microsoft.com/office/2007/relationships/media"

// One slide with a video (its bytes as given) and a picture beside it.
function videoDeck(video: Uint8Array, contentType = "video/mp4"): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes: sp(2, "Title 1", 'type="title"', "", body(para("Media"))) + VIDEO_PIC(4, "rId10", "rId11", "rId12"),
				rels: [
					["rId10", VIDEO, "../media/media1.mp4"],
					["rId11", MEDIA, "../media/media1.mp4"],
					["rId12", "image", "../media/image1.png"]
				]
			}
		],
		parts: {
			"ppt/media/media1.mp4": { data: video, type: contentType },
			"ppt/media/image1.png": { data: image().bytes, type: "image/png" }
		}
	})
}

// The deck with its media entry stored (as PowerPoint and our own inserts write media).
function storedMedia(deck: Uint8Array): Uint8Array {
	const files = unzipSync(deck)

	return zipSync(
		Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { level: name.endsWith(".mp4") ? 0 : 6 }] as const]))
	)
}

interface Served {
	readonly read: (start: number, end: number, signal: CallSignal) => Promise<Uint8Array>
}

interface MediaHarness {
	readonly h: EditHarness
	readonly session: EngineSession
	readonly served: Served[]
	readonly tasks: Task[]
	readonly events: PresentationEvent[]
	media(part: string): Promise<PortStreamMeta | MediaRefusal>
	register(file: FileLike): Promise<InsertedMedia | MediaRefusal>
	runTasks(): Promise<void>
}

const PORT: PortLike = { postMessage: () => undefined, close: () => undefined }
const SIGNAL: CallSignal = { aborted: false, onAbort: () => undefined }
const SLICING = { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }

async function mediaHarness(bytes: Uint8Array): Promise<MediaHarness> {
	const h = await editHarness(bytes)
	const served: Served[] = []
	const tasks: Task[] = []
	const events: PresentationEvent[] = []
	const server: MediaPortServer = {
		serve: (_port, read) => {
			served.push({ read })
		}
	}
	const session: EngineSession = Object.assign(h.session, {
		services: { ...h.session.services, media: server },
		schedule: (_lane: unknown, task: Task) => {
			tasks.push(task)
		},
		emit: (event: PresentationEvent) => {
			events.push(event)
		}
	})
	const context = { ...h.context, session, lane: "background" as const }

	for (let index = 0; index < session.deck.slides.length; index++) await h.slide(index)

	return {
		h,
		session,
		served,
		tasks,
		events,
		media: part => mediaCapability.media(context, part, PORT),
		register: file => mediaCapability.registerMedia(context, { kind: "file", file }),
		runTasks: async () => {
			for (const task of tasks.splice(0)) await task(SLICING, SIGNAL)
		}
	}
}

function fileLike(bytes: Uint8Array, name: string, type: string, reads: { count: number; bytes: number }): FileLike {
	return {
		size: bytes.length,
		name,
		type,
		slice: (start = 0, end = bytes.length) => ({
			arrayBuffer: () => {
				reads.count++
				reads.bytes += end - start

				return Promise.resolve(bytes.slice(start, end).buffer)
			}
		})
	}
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((value, k) => value === b[k])
}

describe("presentation media serving", () => {
	it("serves a stored video by range where the zip has it", async () => {
		const video = mp4(300_000)
		const deck = storedMedia(videoDeck(video))
		const { media, served } = await mediaHarness(deck)
		const archive = await ZipArchive.open(bytesSource(deck))

		expect(archive.get("ppt/media/media1.mp4")?.method).toBe(0)

		const meta = await media("/ppt/media/media1.mp4")

		expect(meta).toEqual({ size: video.length, contentType: "video/mp4", seekable: true })

		const read = served[0]?.read

		if (read === undefined) throw new Error("nothing served")

		const bytes = await read(1000, 70_000, SIGNAL)

		expect(equal(bytes, video.subarray(1000, 70_000))).toBe(true)
		// Its own buffer: the host transfers it, which must not take the deck's bytes with it.
		expect(bytes.buffer.byteLength).toBe(bytes.length)
		expect(equal(await read(video.length - 10, video.length, SIGNAL), video.subarray(video.length - 10))).toBe(true)
	})

	it("offers a deflated video only once its index is built, with progress notices meanwhile", async () => {
		// Compressible enough that the fixture's zip deflates it.
		const video = mp4(3_000_000)

		video.fill(7, 100_000, 2_900_000)

		const deck = videoDeck(video)
		const archive = await ZipArchive.open(bytesSource(deck))

		expect(archive.get("ppt/media/media1.mp4")?.method).toBe(8)

		const harness = await mediaHarness(deck)

		expect(await harness.media("/ppt/media/media1.mp4")).toEqual({ kind: "refused", reason: "preparing" })
		expect(harness.served).toHaveLength(0)
		// Asked again while it builds: still preparing, one build.
		expect(await harness.media("/ppt/media/media1.mp4")).toEqual({ kind: "refused", reason: "preparing" })
		expect(harness.tasks).toHaveLength(1)

		await harness.runTasks()

		const notices = harness.events.flatMap(event => (event.type === "notice" && event.notice.kind === "media" ? [event.notice] : []))

		expect(notices.at(-1)).toMatchObject({ part: "/ppt/media/media1.mp4", reason: "preparing", progress: 1 })

		const meta = await harness.media("/ppt/media/media1.mp4")

		expect(meta).toMatchObject({ size: video.length, seekable: true })
		expect(equal(await (harness.served[0] as Served).read(2_950_000, 3_000_000, SIGNAL), video.subarray(2_950_000))).toBe(true)
	})

	it("starts preparing a rendered slide's deflated video, so a play finds it ready", async () => {
		const video = mp4(3_000_000)

		video.fill(7, 100_000, 2_900_000)

		const harness = await mediaHarness(videoDeck(video))
		const context = { ...harness.h.context, session: harness.session, lane: "background" as const }

		expect(harness.tasks).toHaveLength(0)

		await viewCapability.render(context, [harness.session.deck.slides[0] as never])

		expect(harness.tasks).toHaveLength(1)

		await harness.runTasks()

		expect(await harness.media("/ppt/media/media1.mp4")).toMatchObject({ size: video.length, seekable: true })
		// Rendered again: built already, nothing scheduled.
		await viewCapability.render(context, [harness.session.deck.slides[0] as never])

		expect(harness.tasks).toHaveLength(0)
	})

	it("stops a deflated read whose request was cancelled", async () => {
		const video = mp4(3_000_000)

		video.fill(7, 100_000, 2_900_000)

		const harness = await mediaHarness(videoDeck(video))

		await harness.media("/ppt/media/media1.mp4")
		await harness.runTasks()
		await harness.media("/ppt/media/media1.mp4")

		const read = (harness.served[0] as Served).read

		await expect(read(2_000_000, 2_900_000, { aborted: true, onAbort: () => undefined })).rejects.toThrow()
		expect(equal(await read(2_000_000, 2_000_100, SIGNAL), video.subarray(2_000_000, 2_000_100))).toBe(true)
	})

	it("reads media through the source's media reads when the host has them", async () => {
		const video = mp4(300_000)
		const harness = await mediaHarness(storedMedia(videoDeck(video)))
		const base = harness.session.package.source
		const reads = { media: 0 }

		harness.session.package = {
			...harness.session.package,
			source: Object.assign(Object.create(null) as object, {
				size: base.size,
				read: (offset: number, length: number) => base.read(offset, length),
				readMedia: (offset: number, length: number) => {
					reads.media += length

					return base.read(offset, length)
				}
			})
		}

		await harness.media("/ppt/media/media1.mp4")

		const bytes = await (harness.served[0] as Served).read(1000, 51_000, SIGNAL)

		expect(equal(bytes, video.subarray(1000, 51_000))).toBe(true)
		expect(reads.media).toBeGreaterThanOrEqual(50_000)
	})

	it("drops the indexes used longest ago once their windows pass the session's budget", () => {
		const build = (used: number, windowBytes: number) => ({ used, index: { windowBytes } })
		const builds = new Map<string, { readonly used: number; readonly index: { readonly windowBytes: number } | undefined }>([
			["a", build(1, 40)],
			["b", build(3, 40)],
			["c", build(2, 40)],
			["d", { used: 0, index: undefined }]
		])

		expect(indexesOver(builds, 200, "b")).toEqual([])
		// The one just built is kept whatever its age; the oldest built ones go first.
		expect(indexesOver(builds, 50, "a")).toEqual(["c", "b"])
		expect(indexesOver(builds, 90, "b")).toEqual(["a"])
	})

	it("refuses a part no shape plays, and media bytes that are no container", async () => {
		const harness = await mediaHarness(storedMedia(videoDeck(new TextEncoder().encode("not a video at all, just text that goes on"))))

		expect(await harness.media("/ppt/media/image1.png")).toEqual({ kind: "refused", reason: "notFound" })
		expect(await harness.media("/ppt/media/nothing.mp4")).toEqual({ kind: "refused", reason: "notFound" })
		expect(await harness.media("/ppt/media/media1.mp4")).toEqual({ kind: "refused", reason: "notMedia" })
	})

	it("registers a device file in one pass and serves it as inserted:<id>", async () => {
		const video = mp4(9 * 1024 * 1024, 3)
		const reads = { count: 0, bytes: 0 }
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const registered = await harness.register(fileLike(video, "clip.mp4", "video/mp4", reads))

		expect(registered).toEqual({ id: 1, kind: "video", contentType: "video/mp4", size: video.length, crc32: crc32(video) })
		expect(reads.bytes).toBe(video.length)

		const meta = await harness.media("inserted:1")

		expect(meta).toEqual({ size: video.length, contentType: "video/mp4", seekable: true })
		expect(equal(await (harness.served[0] as Served).read(5_000_000, 5_000_100, SIGNAL), video.subarray(5_000_000, 5_000_100))).toBe(
			true
		)
		expect(await harness.media("inserted:2")).toEqual({ kind: "refused", reason: "notFound" })
	})

	it("refuses a file that is no audio or video", async () => {
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const reads = { count: 0, bytes: 0 }

		expect(await harness.register(fileLike(new TextEncoder().encode("plain text"), "notes.txt", "text/plain", reads))).toEqual({
			kind: "refused",
			reason: "notMedia"
		})
	})

	it("reads an audio file as audio whatever its container", async () => {
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const mp3 = new Uint8Array(5000)

		mp3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])

		const registered = await harness.register(fileLike(mp3, "song.mp3", "", { count: 0, bytes: 0 }))

		expect(registered).toMatchObject({ kind: "audio", contentType: "audio/mpeg" })
	})
})

describe("presentation media edits", () => {
	async function inserted(): Promise<{ harness: MediaHarness; id: number }> {
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const registered = await harness.register(fileLike(mp4(200_000, 9), "clip.mp4", "video/mp4", { count: 0, bytes: 0 }))

		if ("reason" in registered) throw new Error(registered.reason)

		const shape: ShapeNode = {
			id: 0,
			name: "clip.mp4",
			hidden: false,
			kind: "pic",
			xfrm: { x: 1000, y: 1000, cx: 3000, cy: 2000, rot: 0, flipH: false, flipV: false }
		}
		const slide = harness.session.deck.slides[0] as never
		const result = await harness.h.command({
			family: "media",
			kind: "insert",
			slide,
			shape,
			media: { ...registered, poster: image(16, 9) }
		})

		expect(result.ok).toBe(true)

		const shapes = (await harness.h.slide(0)).shapes

		return { harness, id: (shapes[shapes.length - 1] as ShapeNode).id }
	}

	it("inserts a medium as a picture shape playing inserted:<id> over its poster, and undoes it", async () => {
		const { harness, id } = await inserted()
		const shape = (await harness.h.slide(0)).shapes.find(candidate => candidate.id === id)

		expect(shape?.media).toEqual({ kind: "video", part: "inserted:1", contentType: "video/mp4", size: 200_000 })
		expect(shape?.props?.fill).toMatchObject({ kind: "picture" })

		await harness.h.undo()
		expect((await harness.h.slide(0)).shapes.some(candidate => candidate.id === id)).toBe(false)
	})

	it("refuses an insert without a poster or of a medium never registered", async () => {
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const slide = harness.session.deck.slides[0] as never
		const shape: ShapeNode = {
			id: 0,
			name: "x",
			hidden: false,
			kind: "pic",
			xfrm: { x: 0, y: 0, cx: 10, cy: 10, rot: 0, flipH: false, flipV: false }
		}
		const media: InsertedMedia = { id: 5, kind: "video", contentType: "video/mp4", size: 10, crc32: 0, poster: image() }

		expect(await harness.h.command({ family: "media", kind: "insert", slide, shape, media })).toEqual({
			ok: false,
			refusal: "notFound"
		})
		expect(
			await harness.h.command({ family: "media", kind: "insert", slide, shape, media: { ...media, poster: undefined } as never })
		).toEqual({
			ok: false,
			refusal: "malformed"
		})
	})

	it("sets volume, hiding and looping as the slide timing's media node, and undoes them", async () => {
		const harness = await mediaHarness(videoDeck(mp4(1000)))
		const slide = harness.session.deck.slides[0] as never
		const target = { slide, id: 4 }

		expect(
			(await harness.h.command({ family: "media", kind: "setPlayback", target, playback: { volume: 50_000, loop: true } })).ok
		).toBe(true)
		expect((await harness.h.command({ family: "media", kind: "setPlayback", target, playback: { hideWhenStopped: true } })).ok).toBe(
			true
		)
		expect(mediaPlayback((await harness.h.slide(0)).timing, 4)).toEqual({ volume: 50_000, hideWhenStopped: true, loop: true })

		await harness.h.undo()
		expect(mediaPlayback((await harness.h.slide(0)).timing, 4)).toEqual({ volume: 50_000, loop: true })

		await harness.h.undo()
		expect(mediaPlayback((await harness.h.slide(0)).timing, 4)).toEqual({})
		expect(await harness.h.command({ family: "media", kind: "setPlayback", target, playback: { autoPlay: true } })).toEqual({
			ok: false,
			refusal: "unsupported"
		})
		expect(
			await harness.h.command({ family: "media", kind: "setPlayback", target: { slide, id: 2 }, playback: { loop: true } })
		).toEqual({
			ok: false,
			refusal: "unsupported"
		})
	})
})

const EMBEDDED = join(CORPUS_DIR, "pptx", "poi__EmbeddedVideo.pptx")

describe.skipIf(!existsSync(EMBEDDED))("presentation media serving over the corpus", () => {
	it("serves poi EmbeddedVideo's video byte for byte", async () => {
		const deck = new Uint8Array(readFileSync(EMBEDDED))
		const harness = await mediaHarness(deck)
		const archive = await ZipArchive.open(bytesSource(deck))
		const parts = new Set<string>()

		for (const ref of harness.session.deck.slides) {
			for (const shape of harness.session.deck.nodes.get(ref)?.shapes ?? [])
				if (shape.media?.part !== undefined) parts.add(shape.media.part)
		}

		expect(parts.size).toBeGreaterThan(0)

		for (const part of parts) {
			let meta = await harness.media(part)

			if ("reason" in meta && meta.reason === "preparing") {
				await harness.runTasks()
				meta = await harness.media(part)
			}

			if ("reason" in meta) throw new Error(`${part}: ${meta.reason}`)

			const entry = archive.get(part.slice(1))

			if (entry === undefined) throw new Error(`no entry ${part}`)

			const read = (harness.served.at(-1) as Served).read

			expect(equal(await read(0, meta.size, SIGNAL), await archive.read(entry))).toBe(true)
			expect(meta.contentType).toMatch(/^video\//u)
		}
	})
})
