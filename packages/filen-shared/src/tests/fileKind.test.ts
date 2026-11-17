import { describe, expect, it } from "vitest"
import {
	resolveFileKind,
	SNIFF_VERDICTS,
	sniffCandidates,
	sniffForExtension,
	verdictChangesKind,
	type Ambiguity,
	type AmbiguityTable,
	type FileKindSource,
	type FileVerdict
} from "@filen/shared"

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
	pot: "presentation",
	vhd: "code",
	key: "iwork",
	sqlite: "sqlite",
	pdf: "pdf"
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
	// A whole name over the extension it carries: go.mod is no tracker module.
	["go.mod", "application/octet-stream", 100, null, "text", "txt", "name", false, false],
	["src/go.sum", null, 100, null, "text", "txt", "name", false, false],
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
	["messages.pot", "text/x-gettext-translation-template", 300, null, "text", "txt", "mime", true, true],
	// A .vhd is VHDL source or a Virtual Hard Disk: only a read decides, never its type.
	["alu.vhd", "text/x-vhdl", 3_000, null, "code", "vhd", "default", true, true],
	["alu.vhd", null, 3_000, "notVirtualDisk", "code", "vhd", "sniff", true, false],
	["disk.vhd", "application/x-vhd", 3 * MIB, "virtualDisk", null, "vhd", "sniff", true, false],
	// A .key is a Keynote package or a key file: neither until a read decides, and its type never does. Unread, it
	// reads like an unknown extension (a text type makes it text).
	["deck.key", "application/x-iwork-keynote-sffkey", 3 * MIB, null, null, "key", "default", true, true],
	["deck.key", null, 3 * MIB, "iworkPackage", "iwork", "key", "sniff", true, false],
	["server.key", null, 1_700, "notIworkPackage", null, "key", "sniff", true, false],
	["server.key", "text/plain", 1_700, null, "text", "txt", "mime", true, true],
	["server.key", "audio/mpeg", 1_700, null, null, "key", "default", true, true],
	// A .db is a SQLite database only when its head says so; its stored type reads as for an unknown extension.
	["app.db", null, 3 * MIB, null, null, "db", "default", true, true],
	["app.db", "application/octet-stream", 3 * MIB, "sqlite", "sqlite", "sqlite", "sniff", true, false],
	["cache.db", null, 3 * MIB, "notSqlite", null, "db", "sniff", true, false],
	["notes.db", "text/plain", 300, null, "text", "txt", "mime", true, true],
	["clip.db", "audio/mpeg", 300, null, "audio", "mp3", "mime", true, true],
	["app.db", "application/vnd.sqlite3", 3 * MIB, null, "sqlite", "sqlite", "mime", true, true],
	// An .ai is a PDF only when its head holds one; unread, it reads like an unknown extension (stored as a PDF, it is one).
	["logo.ai", "application/illustrator", 3 * MIB, null, null, "ai", "default", true, true],
	["logo.ai", null, 3 * MIB, "pdfCompatible", "pdf", "pdf", "sniff", true, false],
	["logo.ai", null, 3 * MIB, "notPdfCompatible", null, "ai", "sniff", true, false]
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

describe("resolveFileKind on a table with Ogg video", () => {
	const withOgv = (extension: string): string | null => (extension === "ogv" ? "video" : kindOf(extension))

	it.each([
		// A MIME type settles an .ogg or .oga toward audio, never toward video: only a read of its content does.
		["film.ogg", "video/ogg", null, "audio", "ogg", "default"],
		["film.oga", "video/ogg", null, "audio", "oga", "default"],
		["film.ogg", "video/ogg", "video", "video", "ogv", "sniff"],
		["song.ogg", "audio/ogg", null, "audio", "oga", "mime"],
		["film.ogv", "video/ogg", null, "video", "ogv", "mime"],
		["film.ogv", "audio/ogg", null, "audio", "oga", "mime"],
		// No extension: the type names it, Ogg video included.
		["film", "video/ogg", null, "video", "ogv", "mime"]
	] as const)("%s (%s, verdict %s) is %s by .%s", (name, mime, verdict, kind, extension, source) => {
		expect(resolveFileKind({ name, mime, verdict }, withOgv)).toMatchObject({ kind, extension, source })
	})

	it("on a table without Ogg video, an .ogg typed video/ogg stays what it was", () => {
		expect(resolveFileKind({ name: "film.ogg", mime: "video/ogg" }, mobileKindOf)).toMatchObject({ kind: "audio", extension: "ogg" })
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

describe("content sniffs", () => {
	it("names the read for each extension one settles, and none for another", () => {
		expect(
			["ts", "mts", "dot", "pot", "vhd", "key", "db", "ai", "sub", "vcf", "ogg", "webm", "txt", ""].map(extension =>
				sniffForExtension(extension)
			)
		).toEqual([
			"transportStream",
			"transportStream",
			"wordTemplate",
			"presentationTemplate",
			"virtualDisk",
			"iworkPackage",
			"sqlite",
			"pdfCompatible",
			"vobsub",
			"vcard",
			null,
			null,
			null,
			null
		])
	})

	it("pairs each read with its found / not-found verdicts", () => {
		expect(SNIFF_VERDICTS).toEqual({
			transportStream: ["transportStream", "notTransportStream"],
			wordTemplate: ["wordBinary", "notWordBinary"],
			presentationTemplate: ["presentationBinary", "notPresentationBinary"],
			virtualDisk: ["virtualDisk", "notVirtualDisk"],
			iworkPackage: ["iworkPackage", "notIworkPackage"],
			sqlite: ["sqlite", "notSqlite"],
			pdfCompatible: ["pdfCompatible", "notPdfCompatible"],
			wavefront: ["wavefront", "notWavefront"],
			vobsub: ["vobsub", "notVobsub"],
			vcard: ["vcard", "notVcard"]
		})
	})

	it("lists what each read may make the file", () => {
		expect(sniffCandidates("ts")).toEqual(["ts", "m2ts", "ts"])
		expect(sniffCandidates("dot")).toEqual(["dot", "dot", "txt"])
		expect(sniffCandidates("pot")).toEqual(["pot", "pot", "txt"])
		expect(sniffCandidates("vhd")).toEqual(["vhd", null, "vhd"])
		expect(sniffCandidates("key")).toEqual([null, "key", null])
		expect(sniffCandidates("db")).toEqual([null, "sqlite", null])
		expect(sniffCandidates("ai")).toEqual([null, "pdf", null])
		expect(sniffCandidates("obj")).toEqual(["obj", "obj", null])
		expect(sniffCandidates("sub")).toEqual(["sub", null, "sub"])
		expect(sniffCandidates("vcf")).toEqual(["vcf", "vcf", "txt"])
		expect(sniffCandidates("webm")).toEqual([])
	})

	// A read that finds no kind: a binary file under an extension that otherwise means text.
	const disk: Ambiguity = { fallback: "dot", wordBinary: null, notWordBinary: "txt", mimeHint: false, sniff: "wordTemplate" }
	const table: AmbiguityTable = new Map([["dot", disk]])

	it("resolves a null verdict target to no kind, by its own extension", () => {
		expect(resolveFileKind({ name: "disk.dot", size: 300, verdict: "wordBinary" }, kindOf, table)).toEqual({
			kind: null,
			extension: "dot",
			source: "sniff",
			ambiguous: true,
			sniffable: false
		})
		expect(resolveFileKind({ name: "disk.dot", size: 300, verdict: "notWordBinary" }, kindOf, table)).toMatchObject({
			kind: "text",
			extension: "txt"
		})
		expect(sniffCandidates("dot", table)).toEqual(["dot", null, "txt"])
	})

	it("keeps a verdict that takes the kind away", () => {
		expect(verdictChangesKind({ name: "disk.dot", size: 300 }, "wordBinary", kindOf, table)).toBe(true)
		expect(verdictChangesKind({ name: "disk.vhd", size: 300 }, "virtualDisk", kindOf)).toBe(true)
		expect(verdictChangesKind({ name: "deck.key", size: 300 }, "iworkPackage", kindOf)).toBe(true)
	})

	// The kind stays, but the read it settles would otherwise run on every open.
	it("keeps a verdict that settles the read its extension waits on", () => {
		expect(verdictChangesKind({ name: "server.key", size: 300 }, "notIworkPackage", kindOf)).toBe(true)
		expect(resolveFileKind({ name: "server.key", size: 300, verdict: "notIworkPackage" }, kindOf)).toMatchObject({ sniffable: false })
		// One that leaves a viewer, which reads the file anyway, is not kept.
		expect(verdictChangesKind({ name: "alu.vhd", size: 300 }, "notVirtualDisk", kindOf)).toBe(false)
		// A .db's either way: it takes the kind, or settles the read.
		expect(verdictChangesKind({ name: "app.db", size: 300 }, "sqlite", kindOf)).toBe(true)
		expect(verdictChangesKind({ name: "cache.db", size: 300 }, "notSqlite", kindOf)).toBe(true)
		// A media verdict on an extension no read settles changes nothing it would not already.
		expect(verdictChangesKind({ name: "clip.mp4", size: 300 }, "video", kindOf)).toBe(false)
	})

	// An app whose table has no Keynote reads a .key as before: by its MIME type, else no kind.
	it("leaves a .key to its MIME type on a table without Keynote", () => {
		const withoutKey = (extension: string) => (extension === "key" ? null : kindOf(extension))

		expect(resolveFileKind({ name: "server.key", mime: "text/plain" }, withoutKey)).toMatchObject({ kind: "text", extension: "txt" })
		expect(resolveFileKind({ name: "deck.key", mime: "application/octet-stream", verdict: "iworkPackage" }, withoutKey)).toMatchObject({
			kind: null,
			extension: "key"
		})
	})

	// An app whose table has no .vhd reads it as before: by its MIME type, else no kind.
	it("leaves a .vhd to its MIME type on a table without it", () => {
		const withoutVhd = (extension: string) => (extension === "vhd" ? null : kindOf(extension))

		expect(resolveFileKind({ name: "alu.vhd", mime: "text/plain" }, withoutVhd)).toMatchObject({ kind: "text", extension: "txt" })
		expect(resolveFileKind({ name: "disk.vhd", mime: "application/octet-stream" }, withoutVhd)).toMatchObject({
			kind: null,
			extension: "vhd"
		})
	})
})

describe("resolveFileKind for a text/* type the table does not know", () => {
	it("reads it as plain text", () => {
		// KINDS has no csv: the type names a kind of text the table lacks.
		expect(resolveFileKind({ name: "export", mime: "text/csv" }, kindOf)).toMatchObject({
			kind: "text",
			extension: "txt",
			source: "mime"
		})
		expect(resolveFileKind({ name: "export.weird", mime: "text/tab-separated-values; charset=utf-8" }, kindOf)).toMatchObject({
			kind: "text",
			extension: "txt",
			source: "mime"
		})
	})

	it("keeps a kind the table knows for the type", () => {
		expect(resolveFileKind({ name: "script", mime: "text/x-python" }, kindOf)).toMatchObject({ kind: "code", extension: "py" })
	})

	it("has no kind when the table has no plain text either, nor for a type that is not text", () => {
		const noText = (extension: string) => (extension === "txt" ? null : kindOf(extension))

		expect(resolveFileKind({ name: "export", mime: "text/csv" }, noText)).toMatchObject({
			kind: null,
			extension: "",
			source: "default"
		})
		expect(resolveFileKind({ name: "deck", mime: "application/vnd.ms-excel" }, kindOf)).toMatchObject({
			kind: null,
			extension: "",
			source: "default"
		})
	})
})

describe("resolveFileKind for a well-known file name", () => {
	it("reads the exact name before anything else", () => {
		expect(resolveFileKind({ name: "src/Makefile", mime: "text/plain" }, kindOf)).toEqual({
			kind: null,
			extension: "makefile",
			source: "name",
			ambiguous: false,
			sniffable: false
		})
		expect(resolveFileKind({ name: "LICENSE", mime: "application/octet-stream" }, kindOf)).toMatchObject({
			kind: "text",
			extension: "txt",
			source: "name"
		})
		expect(resolveFileKind({ name: ".bashrc", mime: null }, kindOf)).toMatchObject({ kind: "code", extension: "sh", source: "name" })
	})

	it("reads a .env.* name only when its extension is unknown", () => {
		expect(resolveFileKind({ name: ".env.local", mime: null }, kindOf)).toMatchObject({ extension: "ini", source: "name" })
		expect(resolveFileKind({ name: ".env.sh", mime: null }, kindOf)).toMatchObject({
			kind: "code",
			extension: "sh",
			source: "extension"
		})
	})

	// An app whose table knows none of an extension a read settles (mobile's) resolves it exactly as it did before the
	// read existed, whatever its MIME type or media verdict.
	// text/directory reads as a vCard's extension; a table without one still reads the file as plain text.
	it("reads text/directory as plain text on a table without vCards", () => {
		const withoutVcf = (extension: string) => (extension === "vcf" ? null : kindOf(extension))

		expect(resolveFileKind({ name: "card", mime: "text/directory" }, withoutVcf)).toMatchObject({ kind: "text", extension: "txt" })
		const withVcf = (extension: string) => (extension === "vcf" ? "contact" : kindOf(extension))

		expect(resolveFileKind({ name: "card", mime: "text/directory" }, withVcf)).toMatchObject({ kind: "contact", extension: "vcf" })
	})

	// Executable and disk image types read as their extensions; a table without them still gives such a file no kind.
	it("gives an executable or disk image type no kind on a table without them", () => {
		for (const mime of [
			"application/x-msdownload",
			"application/vnd.microsoft.portable-executable",
			"application/x-executable",
			"application/x-sharedlib",
			"application/x-apple-diskimage",
			"application/x-iso9660-image"
		]) {
			expect(resolveFileKind({ name: "program", mime }, kindOf), mime).toMatchObject({ kind: null, extension: "" })
		}
	})

	it.each(["sub", "vcf"])("leaves .%s as before on a table without it", extension => {
		const without = (candidate: string) => (candidate === extension ? null : kindOf(candidate))
		const before: AmbiguityTable = new Map()

		for (const mime of [null, "text/plain", "application/octet-stream", "video/mpeg", "audio/mpeg", "text/x-unknown"]) {
			for (const verdict of [null, "video", "audio", "transportStream"] as const) {
				const input = { name: `file.${extension}`, mime, size: 4096, verdict }
				const now = resolveFileKind(input, without)
				const then = resolveFileKind(input, without, before)

				expect({ kind: now.kind, extension: now.extension }).toEqual({ kind: then.kind, extension: then.extension })
				expect(verdictChangesKind(input, verdict ?? "video", without)).toBe(
					verdictChangesKind(input, verdict ?? "video", without, before)
				)
			}
		}
	})
})
