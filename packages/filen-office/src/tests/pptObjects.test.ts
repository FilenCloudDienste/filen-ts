import { deflateSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { CommentAuthors, commentsXml, slideComments } from "../core/ppt/comments"
import type { PptFile } from "../core/ppt/document"
import { pathUri, PptMedia } from "../core/ppt/media"
import { PptOle } from "../core/ppt/ole"
import { children, RecordCounter } from "../core/ppt/records"
import { PptReport } from "../core/ppt/report"
import { concat, container, record } from "./pptFixtures"

// Comments (§2.5.25), sounds and movies (§2.4.16, §2.10.4–§2.10.33) and embedded OLE objects (§2.10.27–§2.10.36) of a
// PowerPoint 97–2003 deck, as their PresentationML parts and elements.

function u16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

function u32(value: number): Uint8Array {
	const out = new Uint8Array(4)

	new DataView(out.buffer).setUint32(0, value >>> 0, true)

	return out
}

function utf16(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2)

	for (let k = 0; k < text.length; k++) {
		out[2 * k] = text.charCodeAt(k) & 0xff
		out[2 * k + 1] = text.charCodeAt(k) >>> 8
	}

	return out
}

const cString = (instance: number, text: string): Uint8Array => record(0x0fba, utf16(text), instance)

function comment(author: string, initials: string, text: string, index: number, time: readonly number[], x: number, y: number): Uint8Array {
	return container(0x2ee0, [
		cString(0, author),
		cString(1, text),
		cString(2, initials),
		record(0x2ee1, concat(u32(index), ...time.map(u16), u32(x), u32(y)))
	])
}

describe("ppt comments", () => {
	it("writes each slide's comments and the deck's authors once each", () => {
		const data = concat(
			comment("Ann Lee", "AL", "Check <this> & that", 1, [2009, 3, 2, 17, 9, 30, 5, 120], 100, 200),
			comment("Ann Lee", "AL", "Second", 4, [2009, 13, 0, 1, 0, 0, 0, 0], 0, 0),
			comment("Bo", "B", "Other", 2, [2010, 1, 5, 1, 0, 0, 0, 0], 576, 576)
		)
		const comments = slideComments(data, children(data, 0, data.length, new RecordCounter()), new RecordCounter())
		const authors = new CommentAuthors()
		const xml = commentsXml(comments, authors)

		expect(comments.map(item => [item.author, item.index, item.dateTime])).toEqual([
			["Ann Lee", 1, "2009-03-17T09:30:05.120"],
			["Ann Lee", 4, undefined],
			["Bo", 2, "2010-01-01T00:00:00.000"]
		])
		expect(xml).toContain(
			'<p:cm authorId="0" dt="2009-03-17T09:30:05.120" idx="1"><p:pos x="100" y="200"/><p:text>Check &lt;this&gt; &amp; that</p:text></p:cm>'
		)
		expect(xml).toContain('<p:cm authorId="0" idx="4">')
		expect(xml).toContain('<p:cm authorId="1" dt="2010-01-01T00:00:00.000" idx="2"><p:pos x="576" y="576"/>')
		expect(authors.xml()).toContain('<p:cmAuthor id="0" name="Ann Lee" initials="AL" lastIdx="4" clrIdx="0"/>')
		expect(authors.xml()).toContain('<p:cmAuthor id="1" name="Bo" initials="B" lastIdx="2" clrIdx="1"/>')
	})
})

// ExMediaAtom: exObjId and flags.
const mediaAtom = (id: number): Uint8Array => record(0x1004, concat(u32(id), u32(0)))

function documentOf(data: Uint8Array): ReturnType<typeof children> {
	return children(data, 0, data.length, new RecordCounter())
}

describe("ppt sounds and movies", () => {
	const sound = container(0x07e6, [
		cString(0, "Chime"),
		cString(1, ".wav"),
		cString(2, "3"),
		record(0x07e7, Uint8Array.of(82, 73, 70, 70, 1, 2))
	])
	const data = concat(
		container(0x07e4, [record(0x07e5, u32(3)), sound], 5),
		container(0x0409, [
			container(0x1006, [container(0x1005, [mediaAtom(1), cString(0, "C:\\Movies\\Clip one.avi")])]),
			container(0x100f, [mediaAtom(2), record(0x1013, concat(u32(3), u32(1500)), 1)]),
			container(0x1010, [mediaAtom(4), cString(0, "\\\\server\\share\\a.wav")]),
			container(0x100e, [mediaAtom(5), record(0x1012, concat(Uint8Array.of(2, 1, 30, 0), Uint8Array.of(2, 2, 0, 0)))])
		])
	)

	it("links movies and sounds the file names, never embedding them, and embeds the collection's sounds", async () => {
		const media = new PptMedia(data, documentOf(data), new RecordCounter())
		const rels: string[] = []
		const add = (type: string, target: string, external?: boolean): string => {
			rels.push(`${type} ${target}${external === true ? " external" : ""}`)

			return `rId${String(rels.length)}`
		}

		expect(media.nvPrXml(1, add)).toBe('<a:videoFile r:link="rId1"/>')
		expect(media.nvPrXml(2, add)).toBe('<a:wavAudioFile r:embed="rId2" name="Chime"/>')
		expect(media.nvPrXml(4, add)).toBe('<a:audioFile r:link="rId3"/>')
		expect(media.nvPrXml(5, add)).toBe('<a:audioCd><a:st track="2" time="90"/><a:end track="2" time="120"/></a:audioCd>')
		expect(media.nvPrXml(9, add)).toBeUndefined()
		expect(rels).toEqual([
			"video file:///C:/Movies/Clip%20one.avi external",
			"audio ../media/audio1.wav",
			"audio file://server/share/a.wav external"
		])

		const parts = new Map<string, Uint8Array | { size: number; read(): Promise<Uint8Array> }>()
		const defaults = new Map<string, string>()

		media.finish(parts, defaults)

		const part = parts.get("ppt/media/audio1.wav")

		expect(part !== undefined && !(part instanceof Uint8Array) ? await part.read() : undefined).toEqual(
			Uint8Array.of(82, 73, 70, 70, 1, 2)
		)
		expect(defaults.get("wav")).toBe("audio/wav")
		expect(media.sound(3, () => "rId9")).toEqual({ rId: "rId9", name: "Chime" })
		expect(media.sound(0, () => "rId9")).toBeUndefined()
	})

	it("writes relative paths as relative links", () => {
		expect(pathUri("movies\\a b.mpg")).toBe("movies/a%20b.mpg")
	})
})

// A PptFile over a stream whose persist objects are at the given offsets (what PptOle reads of it).
function fileOf(stream: Uint8Array, offsets: ReadonlyMap<number, number>): PptFile {
	return { stream, directory: { offsets }, counter: new RecordCounter() } as unknown as PptFile
}

function oleEmbed(id: number, persistId: number, progId: string, aspect = 1): Uint8Array {
	return container(0x0fcc, [
		record(0x0fcd, concat(u32(0), Uint8Array.of(0, 0, 0, 0))),
		record(0x0fc3, concat(u32(aspect), u32(0), u32(id), u32(3), u32(persistId), u32(0))),
		cString(1, "Worksheet"),
		cString(2, progId)
	])
}

describe("ppt embedded objects", () => {
	const storage = Uint8Array.from({ length: 3000 }, (_, k) => k % 7)
	const list = container(0x0409, [
		oleEmbed(1, 10, "Excel.Sheet.8"),
		oleEmbed(2, 11, "Word.Document.8", 4),
		oleEmbed(3, 12, "Damaged"),
		oleEmbed(4, 99, "Gone")
	])
	const stored = record(0x1011, storage, 0)
	const compressed = record(0x1011, concat(u32(storage.length), new Uint8Array(deflateSync(storage))), 1)
	const damaged = record(0x1011, concat(u32(storage.length), new Uint8Array(deflateSync(storage)).subarray(0, 20)), 1)
	const stream = concat(list, stored, compressed, damaged)
	const offsets = new Map([
		[10, list.length],
		[11, list.length + stored.length],
		[12, list.length + stored.length + compressed.length]
	])
	const frame = {
		cNvPr: '<p:cNvPr id="4" name="Object 4"/>',
		xfrm: '<p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm>',
		ph: "",
		picture: "<p:pic/>"
	}

	it("embeds an object's storage as a part and keeps its preview picture inside", async () => {
		const ole = new PptOle(fileOf(stream, offsets), documentOf(list), new PptReport())
		const targets: string[] = []
		const add = (type: string, target: string): string => {
			targets.push(`${type} ${target}`)

			return `rId${String(targets.length)}`
		}

		expect(ole.frameXml(1, frame, add)).toBe(
			'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Object 4"/><p:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj name="Worksheet" r:id="rId1" progId="Excel.Sheet.8"><p:embed/><p:pic/></p:oleObj></a:graphicData></a:graphic></p:graphicFrame>'
		)
		expect(ole.frameXml(2, frame, add)).toContain('progId="Word.Document.8" showAsIcon="1"><p:embed/>')
		expect(targets).toEqual(["oleObject ../embeddings/oleObject1.bin", "oleObject ../embeddings/oleObject2.bin"])

		const parts = new Map<string, Uint8Array | { size: number; read(): Promise<Uint8Array> }>()
		const defaults = new Map<string, string>()

		ole.finish(parts, defaults)

		for (const name of ["ppt/embeddings/oleObject1.bin", "ppt/embeddings/oleObject2.bin"]) {
			const part = parts.get(name)

			expect(part === undefined || part instanceof Uint8Array ? undefined : { size: part.size, bytes: await part.read() }).toEqual({
				size: storage.length,
				bytes: storage
			})
		}

		expect(defaults.get("bin")).toBe("application/vnd.openxmlformats-officedocument.oleObject")
	})

	it("gives shapes showing the same object one part", () => {
		const ole = new PptOle(fileOf(stream, offsets), documentOf(list), new PptReport())
		const targets: string[] = []
		const add = (type: string, target: string): string => {
			targets.push(`${type} ${target}`)

			return "rId1"
		}

		ole.frameXml(1, frame, add)
		ole.frameXml(1, frame, add)

		const parts = new Map<string, Uint8Array | { size: number; read(): Promise<Uint8Array> }>()

		ole.finish(parts, new Map())
		expect(targets).toEqual(["oleObject ../embeddings/oleObject1.bin", "oleObject ../embeddings/oleObject1.bin"])
		expect([...parts.keys()]).toEqual(["ppt/embeddings/oleObject1.bin"])
	})

	it("keeps the picture alone for a missing storage or an object that is not embedded", () => {
		const ole = new PptOle(fileOf(stream, offsets), documentOf(list), new PptReport())
		const add = (): string => "rId1"

		expect(ole.frameXml(4, frame, add)).toBeUndefined()
		expect(ole.frameXml(5, frame, add)).toBeUndefined()
	})

	it("writes a damaged storage at its stated size, padded with zeros, and reports the slides showing it", async () => {
		const report = new PptReport()
		const ole = new PptOle(fileOf(stream, offsets), documentOf(list), report)
		const add = (): string => "rId1"

		expect(ole.frameXml(3, frame, add, 2)).toContain("<p:embed/>")
		expect(ole.frameXml(3, frame, add, 5)).toContain("<p:embed/>")
		expect(report.losses()).toEqual([])

		const parts = new Map<string, Uint8Array | { size: number; read(): Promise<Uint8Array> }>()

		ole.finish(parts, new Map())

		const part = parts.get("ppt/embeddings/oleObject1.bin")
		const bytes = part === undefined || part instanceof Uint8Array ? undefined : await part.read()

		expect(bytes?.length).toBe(storage.length)
		expect(bytes?.subarray(-100).every(byte => byte === 0)).toBe(true)
		expect(report.losses()).toEqual([{ kind: "oleObject", count: 2, slides: [2, 5] }])
	})

	it("places the frame as the shape is placed, with its placeholder", () => {
		const ole = new PptOle(fileOf(stream, offsets), documentOf(list), new PptReport())
		const xml = ole.frameXml(1, { ...frame, xfrm: '<p:xfrm rot="60000" flipV="1"/>', ph: '<p:ph type="obj" idx="1"/>' }, () => "rId1")

		expect(xml).toContain('<p:nvPr><p:ph type="obj" idx="1"/></p:nvPr></p:nvGraphicFramePr><p:xfrm rot="60000" flipV="1"/><a:graphic>')
	})
})
