import { describe, expect, it } from "vitest"
import { resolveFileKind, verdictChangesKind, type FileKindSource, type FileVerdict } from "@filen/shared"

// An app table as web's preview categories read it.
const KINDS: Readonly<Record<string, string>> = {
	ts: "code",
	py: "code",
	txt: "text",
	md: "markdown",
	sh: "code",
	json: "code",
	mp4: "video",
	m4v: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
	m2ts: "video",
	mp3: "audio",
	m4a: "audio",
	ogg: "audio",
	oga: "audio",
	weba: "audio",
	gz: "archive",
	jpg: "image",
	docx: "docx",
	dot: "docx",
	pot: "presentation"
}

function kindOf(extension: string): string | null {
	return KINDS[extension] ?? null
}

const MIB = 1024 * 1024

type Row = [
	name: string,
	mime: string | null,
	size: number,
	verdict: FileVerdict | null,
	kind: string | null,
	extension: string,
	source: FileKindSource,
	ambiguous: boolean,
	sniffable: boolean
]

const ROWS: Row[] = [
	// TypeScript uploads as video/mp2t: the MIME type never makes a .ts a video.
	["index.ts", "video/mp2t", 4_000, null, "code", "ts", "default", true, false],
	["bundle.ts", "video/mp2t", 4 * MIB, null, "code", "ts", "default", true, true],
	["bundle.ts", "video/mp2t", 4 * MIB, "notTransportStream", "code", "ts", "sniff", true, false],
	["lib.d.ts", "video/mp2t", 4 * MIB, null, "code", "ts", "default", true, false],
	// A real transport stream, once a read said so.
	["clip.ts", "video/mp2t", 40 * MIB, "transportStream", "video", "m2ts", "sniff", true, false],
	["CLIP.TS", null, 40 * MIB, "transportStream", "video", "m2ts", "sniff", true, false],
	["camera.mts", "video/mp2t", 40 * MIB, null, null, "mts", "default", true, true],
	["module.mts", null, 40 * MIB, "notTransportStream", null, "mts", "default", true, false],
	["camera.mts", "video/mp2t", 40 * MIB, "transportStream", "video", "m2ts", "sniff", true, false],
	["movie.m2ts", "video/mp2t", 40 * MIB, null, "video", "m2ts", "extension", false, false],
	// Audio or video containers: a verdict, else the MIME type's family, else the usual meaning.
	["talk.webm", "audio/webm", MIB, null, "audio", "weba", "mime", true, true],
	["talk.webm", "video/webm", MIB, null, "video", "webm", "mime", true, true],
	["talk.webm", null, MIB, null, "video", "webm", "default", true, true],
	["talk.webm", "video/webm", MIB, "audio", "audio", "weba", "sniff", true, false],
	["song.ogg", "audio/ogg", MIB, null, "audio", "oga", "mime", true, true],
	// The table has no .ogv: the MIME hint is passed over for the usual meaning.
	["film.ogg", "video/ogg", MIB, null, "audio", "ogg", "default", true, true],
	["song.ogg", null, MIB, null, "audio", "ogg", "default", true, true],
	["voice.mp4", "audio/mp4", MIB, null, "audio", "m4a", "mime", true, true],
	["voice.m4a", "video/mp4", MIB, "audio", "audio", "m4a", "sniff", true, false],
	["film.mkv", "video/x-matroska", MIB, null, "video", "mkv", "mime", true, true],
	["album.mka", "audio/x-matroska", MIB, null, null, "mka", "default", true, true],
	// An audio-only .mkv on a table without .mka stays the video it reads as.
	["concert.mkv", "video/x-matroska", MIB, "audio", "video", "mkv", "mime", true, false],
	// No or an unknown extension: a specific MIME type, then a well-known name, then a generic type.
	["recording", "video/mp2t", 40 * MIB, null, "video", "m2ts", "mime", false, false],
	// A well-known name wins over any MIME type.
	["Makefile", "video/mp4", 100, null, null, "makefile", "name", false, false],
	["recording", "application/octet-stream", MIB, null, null, "", "default", false, false],
	["recording", "", MIB, null, null, "", "default", false, false],
	["Makefile", "text/plain", 100, null, null, "makefile", "name", false, false],
	["LICENSE", "application/octet-stream", 100, null, "text", "txt", "name", false, false],
	["notes", "text/plain", 100, null, "text", "txt", "mime", false, false],
	["notes", "application/octet-stream", 100, null, null, "", "default", false, false],
	["data.weird", "application/json", 100, null, "code", "json", "mime", false, false],
	// A known extension that means one thing wins, whatever the type says; the last extension counts.
	["photo.JPG", "application/octet-stream", 100, null, "image", "jpg", "extension", false, false],
	["backup.tar.gz", "application/gzip", 100, null, "archive", "gz", "extension", false, false],
	["notes.md", "text/plain", 100, null, "markdown", "md", "extension", false, false],
	// A .dot is a Word 97–2003 template or a Graphviz (text) file: a read of its signature decides, else a text
	// MIME type, else the template.
	["letter.dot", "application/msword", 30_000, null, "docx", "dot", "default", true, true],
	["letter.dot", null, 30_000, "wordBinary", "docx", "dot", "sniff", true, false],
	["graph.dot", "application/msword", 300, "notWordBinary", "text", "txt", "sniff", true, false],
	["graph.dot", "text/vnd.graphviz", 300, null, "text", "txt", "mime", true, true],
	// A .pot is a PowerPoint 97–2003 template or a gettext template (text): the same rule.
	["deck.pot", "application/vnd.ms-powerpoint", 30_000, null, "presentation", "pot", "default", true, true],
	["deck.pot", null, 30_000, "presentationBinary", "presentation", "pot", "sniff", true, false],
	["messages.pot", null, 300, "notPresentationBinary", "text", "txt", "sniff", true, false],
	["messages.pot", "text/x-gettext-translation-template", 300, null, "text", "txt", "mime", true, true]
]

describe("resolveFileKind", () => {
	it.each(ROWS)(
		"%s (%s, %d B, verdict %s) is %s by .%s from %s",
		(name, mime, size, verdict, kind, extension, source, ambiguous, sniffable) => {
			expect(resolveFileKind({ name, mime, size, verdict }, kindOf)).toEqual({ kind, extension, source, ambiguous, sniffable })
		}
	)

	it("keeps a .dot's verdict only where it changes the kind", () => {
		const graph = { name: "graph.dot", mime: "application/msword", size: 300 }

		expect(verdictChangesKind(graph, "notWordBinary", kindOf)).toBe(true)
		expect(verdictChangesKind(graph, "wordBinary", kindOf)).toBe(false)
	})

	it("keeps a .pot's verdict only where it changes the kind, and never takes a Word verdict for it", () => {
		const messages = { name: "messages.pot", size: 300 }

		expect(verdictChangesKind(messages, "notPresentationBinary", kindOf)).toBe(true)
		expect(verdictChangesKind(messages, "presentationBinary", kindOf)).toBe(false)
		expect(resolveFileKind({ ...messages, verdict: "notWordBinary" }, kindOf).extension).toBe("pot")
	})

	it("says nothing is sniffable for a .ts of unknown size", () => {
		expect(resolveFileKind({ name: "clip.ts" }, kindOf).sniffable).toBe(false)
	})
})

// The mobile app's table today: no .weba, .oga, .ogv, .mka or .m2ts.
const MOBILE: Readonly<Record<string, string>> = {
	mp4: "video",
	mov: "video",
	webm: "video",
	mkv: "video",
	mp3: "audio",
	m4a: "audio",
	ogg: "audio",
	wav: "audio",
	ts: "code"
}

function mobileKindOf(extension: string): string | null {
	return MOBILE[extension] ?? null
}

describe("resolveFileKind on a table without the audio and video siblings", () => {
	it.each([
		["talk.webm", "audio/webm", null, "video", "webm"],
		["concert.mkv", "audio/x-matroska", "audio", "video", "mkv"],
		["film.ogg", "video/ogg", null, "audio", "ogg"],
		["voice.mp4", "audio/mp4", null, "audio", "m4a"],
		["clip.ts", "video/mp2t", "transportStream", "code", "ts"]
	] as const)("%s (%s, verdict %s) stays %s by .%s", (name, mime, verdict, kind, extension) => {
		expect(resolveFileKind({ name, mime, verdict }, mobileKindOf)).toMatchObject({ kind, extension })
	})
})

describe("resolveFileKind when none of an extension's meanings is in the table", () => {
	it.each([
		// Web-shaped: no .ogv or .mka.
		[kindOf, "film.ogv", "video/ogg", null, null, "ogv", "default"],
		[kindOf, "album.mka", "audio/mpeg", null, "audio", "mp3", "mime"],
		[kindOf, "album.mka", "audio/x-matroska", null, null, "mka", "default"],
		// Its usual meaning known: never falls through.
		[kindOf, "film.ogv", "audio/ogg", null, "audio", "oga", "mime"],
		[kindOf, "talk.webm", "text/plain", null, "video", "webm", "default"],
		// Mobile-shaped: no .mts, .oga, .ogv, .weba or .mka.
		[mobileKindOf, "camera.mts", "video/mp2t", null, null, "mts", "default"],
		[mobileKindOf, "camera.mts", "video/mp4", null, null, "mts", "default"],
		[mobileKindOf, "camera.mts", "video/mp2t", "transportStream", null, "mts", "default"],
		[mobileKindOf, "module.mts", "application/typescript", null, "code", "ts", "mime"],
		[mobileKindOf, "notes.mts", "text/plain", null, null, "mts", "default"],
		[mobileKindOf, "voice.oga", "audio/mpeg", null, "audio", "mp3", "mime"],
		[mobileKindOf, "voice.weba", "audio/wav", "audio", "audio", "wav", "mime"],
		[mobileKindOf, "voice.weba", "video/webm", null, "video", "webm", "mime"],
		[mobileKindOf, "voice.weba", "application/octet-stream", null, null, "weba", "default"]
	] as const)("%#: %s (%s, verdict %s) is %s by .%s from %s", (table, name, mime, verdict, kind, extension, source) => {
		expect(resolveFileKind({ name, mime, size: MIB, verdict }, table)).toMatchObject({ kind, extension, source, ambiguous: true })
	})

	it("reads a well-known name first, as for an unknown extension", () => {
		expect(resolveFileKind({ name: ".env.mts", mime: "video/mp2t" }, mobileKindOf)).toMatchObject({
			kind: null,
			extension: "ini",
			source: "name",
			ambiguous: true
		})
	})

	it("keeps sniffable as the ambiguity decides it", () => {
		expect(resolveFileKind({ name: "notes.mts", mime: "text/plain", size: 40 * MIB }, mobileKindOf).sniffable).toBe(true)
		expect(resolveFileKind({ name: "notes.mts", mime: "text/plain", size: 4_000 }, mobileKindOf).sniffable).toBe(false)
		expect(resolveFileKind({ name: "voice.oga", mime: "audio/mpeg" }, mobileKindOf).sniffable).toBe(true)
		expect(resolveFileKind({ name: "voice.oga", mime: "audio/mpeg", verdict: "audio" }, mobileKindOf).sniffable).toBe(false)
	})

	it("never makes a .ts a video by its type: its usual meaning is in both apps' tables", () => {
		for (const table of [kindOf, mobileKindOf]) {
			for (const mime of ["video/mp2t", "video/mp4", "audio/mpeg", "application/octet-stream", null]) {
				expect(resolveFileKind({ name: "clip.ts", mime, size: 40 * MIB }, table)).toMatchObject({
					kind: "code",
					extension: "ts",
					source: "default"
				})
			}
		}
	})
})

describe("verdictChangesKind", () => {
	it("keeps only a verdict that moves an ambiguous file to another kind or settles a .ts", () => {
		expect(verdictChangesKind({ name: "clip.ts", size: 40 * MIB }, "transportStream", kindOf)).toBe(true)
		expect(verdictChangesKind({ name: "server.ts", size: 40 * MIB }, "notTransportStream", kindOf)).toBe(true)
		expect(verdictChangesKind({ name: "index.ts", size: 4_000 }, "notTransportStream", kindOf)).toBe(false)
		expect(verdictChangesKind({ name: "lib.d.ts", size: 40 * MIB }, "notTransportStream", kindOf)).toBe(false)
		expect(verdictChangesKind({ name: "talk.webm", mime: "video/webm" }, "audio", kindOf)).toBe(true)
		expect(verdictChangesKind({ name: "talk.webm", mime: "video/webm" }, "video", kindOf)).toBe(false)
		expect(verdictChangesKind({ name: "film.mp4" }, "video", kindOf)).toBe(false)
		expect(verdictChangesKind({ name: "photo.jpg" }, "audio", kindOf)).toBe(false)
	})
})
