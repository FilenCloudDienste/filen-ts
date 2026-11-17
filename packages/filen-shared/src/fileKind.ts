import { extensionStart } from "./fileExtensions"
import { extensionForExactFileName, extensionForFileName, extensionForMime } from "./fileType"
import { MIN_TRANSPORT_STREAM_BYTES } from "./videos/transportStream"

export { MIN_TRANSPORT_STREAM_BYTES }

// What kind of file something is, decided in one place for both apps, from what is at hand without a
// read: its extension, a content verdict an earlier read left behind, its stored MIME type, a well-known
// file name. The kind itself is each app's (what it can show differs by platform): the app passes
// `kindOf`, its own extension table, and this decides which extension that table is asked about.
//
// 0. A file named exactly as a well-known one (LICENSE, Makefile, .gitignore) is what the name says.
// 1. A known extension that means one thing wins.
// 2. An extension that means two (`.ts` TypeScript or an MPEG transport stream; `.webm`, `.ogg`, `.mp4`,
//    `.mkv` and their audio siblings; `.dot` a Word 97–2003 template or a Graphviz/text file; `.pot` a PowerPoint
//    97–2003 template or a gettext template; `.vhd` VHDL source or a Virtual Hard Disk; `.key` a Keynote package or
//    anything else, a key file most often; `.db` a SQLite database or any other program's data; `.ai` an Illustrator
//    file saved PDF-compatible or one that is PostScript only) is settled by a
//    content verdict for the file when one exists, else by
//    a MIME type that says audio or video (text, for a `.dot` or `.pot`), else by its usual meaning. A MIME type never makes a `.ts` a
//    video: browsers upload TypeScript as video/mp2t too. One with no usual meaning (`.key`) reads, until a verdict
//    says otherwise, like an unknown extension, as in 3.
// 3. No or an unknown extension: a well-known name prefix (`.env.local`), else its MIME type, else, for a text/*
//    type the table does not know, plain text, else unknown.
// Whatever a verdict or a MIME type points at, an extension the caller's table does not know is passed over
// for the next candidate: an app that has no audio Matroska keeps showing an `.mkv` as video. An extension
// none of whose meanings the table knows is read as in 3 (an `.ogg` typed audio/opus on a table without
// Ogg is Opus), but a `.ts` or `.mts` is still never made a media file by its type.

// What a read of the file's content found.
export type ContentVerdict = "transportStream" | "notTransportStream" | "video" | "audio"

// What a read of a `.dot` (or a `.pot`) found: a Word (PowerPoint) binary compound file ([MS-CFB] signature) or not;
// of a `.vhd`: a Virtual Hard Disk or not; of a `.key`: a Keynote package (a zip) or not; of a `.db`: a SQLite
// database or not; of an `.ai`: a PDF inside or not; of a `.obj`: a Wavefront model (text) or not; of a `.sub`: a
// VobSub (an MPEG program stream) or text; of a `.vcf`: a vCard or other text (a genomics Variant Call Format file).
// Kept apart from the media verdicts the apps persist.
export type DocumentVerdict =
	| "wordBinary"
	| "notWordBinary"
	| "presentationBinary"
	| "notPresentationBinary"
	| "virtualDisk"
	| "notVirtualDisk"
	| "iworkPackage"
	| "notIworkPackage"
	| "sqlite"
	| "notSqlite"
	| "pdfCompatible"
	| "notPdfCompatible"
	| "wavefront"
	| "notWavefront"
	| "vobsub"
	| "notVobsub"
	| "vcard"
	| "notVcard"

export type FileVerdict = ContentVerdict | DocumentVerdict

// The content read that settles an extension meaning two things (the app runs it before choosing a viewer), named
// `{format}`, its verdicts `{format}` / `not{Format}` (a verdict already in use keeps its name):
//   transportStream       ts mts  transportStream / notTransportStream
//   wordTemplate          dot     wordBinary / notWordBinary
//   presentationTemplate  pot     presentationBinary / notPresentationBinary
//   virtualDisk           vhd     virtualDisk / notVirtualDisk
//   iworkPackage          key     iworkPackage / notIworkPackage
//   sqlite                db      sqlite / notSqlite
//   pdfCompatible         ai      pdfCompatible / notPdfCompatible
//   wavefront             obj     wavefront / notWavefront
//   vobsub                sub     vobsub / notVobsub
//   vcard                 vcf     vcard / notVcard
// Reserved, added with their readers: mpegPs (mod), executable (no extension).
export type SniffId =
	| "transportStream"
	| "wordTemplate"
	| "presentationTemplate"
	| "virtualDisk"
	| "iworkPackage"
	| "sqlite"
	| "pdfCompatible"
	| "wavefront"
	| "vobsub"
	| "vcard"

// Each read's verdicts: what it found, what it did not.
export const SNIFF_VERDICTS: Readonly<Record<SniffId, readonly [found: FileVerdict, notFound: FileVerdict]>> = {
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
}

export type FileKindSource = "extension" | "sniff" | "mime" | "name" | "default"

export interface FileKindInput {
	name: string
	mime?: string | null | undefined
	// Bytes; decides whether a content read could still change the kind (`sniffable`).
	size?: number | bigint | undefined
	verdict?: FileVerdict | null | undefined
}

export interface FileKind<K> {
	kind: K | null
	// The extension `kindOf` was asked about ("" when there was none).
	extension: string
	source: FileKindSource
	// The extension alone does not settle the kind: a content verdict may change it.
	ambiguous: boolean
	// Ambiguous, without a verdict yet, and a file a content read could still turn into another kind (a
	// `.ts` large enough to be a transport stream). A caller reading the file anyway may record one.
	sniffable: boolean
}

// What each verdict makes the file: another extension's kind, or null for no kind at all (a binary file under a text
// extension).
export interface Ambiguity {
	// The usual meaning; null for none, when only a read gives the extension a kind.
	fallback: string | null
	audio?: string
	video?: string
	transportStream?: string | null
	wordBinary?: string | null
	notWordBinary?: string | null
	presentationBinary?: string | null
	notPresentationBinary?: string | null
	virtualDisk?: string | null
	notVirtualDisk?: string | null
	iworkPackage?: string | null
	notIworkPackage?: string | null
	sqlite?: string | null
	notSqlite?: string | null
	pdfCompatible?: string | null
	notPdfCompatible?: string | null
	wavefront?: string | null
	notWavefront?: string | null
	vobsub?: string | null
	notVobsub?: string | null
	vcard?: string | null
	notVcard?: string | null
	// What a text/* MIME type makes it.
	text?: string
	// Whether a MIME type may settle it; "audioOnly": toward audio, never toward video (an `.ogg` some uploaders type
	// video/ogg is music unless a read of its content says otherwise).
	mimeHint: boolean | "audioOnly"
	// The content read the app runs before choosing a viewer, while no verdict settles it.
	sniff?: SniffId
}

const TRANSPORT_STREAM = "m2ts"

export type AmbiguityTable = ReadonlyMap<string, Ambiguity>

const AMBIGUOUS: AmbiguityTable = new Map<string, Ambiguity>([
	["ts", { fallback: "ts", transportStream: TRANSPORT_STREAM, mimeHint: false, sniff: "transportStream" }],
	["mts", { fallback: "mts", transportStream: TRANSPORT_STREAM, mimeHint: false, sniff: "transportStream" }],
	["ogg", { fallback: "ogg", audio: "oga", video: "ogv", mimeHint: "audioOnly" }],
	["oga", { fallback: "oga", audio: "oga", video: "ogv", mimeHint: "audioOnly" }],
	["ogv", { fallback: "ogv", audio: "oga", video: "ogv", mimeHint: true }],
	["webm", { fallback: "webm", audio: "weba", video: "webm", mimeHint: true }],
	["weba", { fallback: "weba", audio: "weba", video: "webm", mimeHint: true }],
	["mp4", { fallback: "mp4", audio: "m4a", video: "mp4", mimeHint: true }],
	["m4a", { fallback: "m4a", audio: "m4a", video: "mp4", mimeHint: true }],
	["mkv", { fallback: "mkv", audio: "mka", video: "mkv", mimeHint: true }],
	["mka", { fallback: "mka", audio: "mka", video: "mkv", mimeHint: true }],
	["dot", { fallback: "dot", wordBinary: "dot", notWordBinary: "txt", text: "txt", mimeHint: false, sniff: "wordTemplate" }],
	[
		"pot",
		{
			fallback: "pot",
			presentationBinary: "pot",
			notPresentationBinary: "txt",
			text: "txt",
			mimeHint: false,
			sniff: "presentationTemplate"
		}
	],
	// VHDL source unless its head carries a Virtual Hard Disk's footer copy. Only a read decides: browsers type both by
	// the extension alone.
	["vhd", { fallback: "vhd", virtualDisk: null, notVirtualDisk: "vhd", mimeHint: false, sniff: "virtualDisk" }],
	// A Keynote package is a zip; a `.key` that is not one (a private key, a licence key) has no kind its name gives.
	// Neither meaning is the usual one, and browsers type both by the extension alone.
	["key", { fallback: null, iworkPackage: "key", notIworkPackage: null, mimeHint: false, sniff: "iworkPackage" }],
	// Many programs' data: a SQLite database only when its head says so. Neither meaning is the usual one; a MIME type
	// it was stored under still reads as for an unknown extension.
	["db", { fallback: null, sqlite: "sqlite", notSqlite: null, mimeHint: true, sniff: "sqlite" }],
	// Illustrator saves a PDF inside an `.ai` unless "Create PDF Compatible File" was off (PostScript only, which nothing
	// here renders). Only a read of its head tells; neither is the usual meaning.
	["ai", { fallback: null, pdfCompatible: "pdf", notPdfCompatible: null, mimeHint: false, sniff: "pdfCompatible" }],
	// A Wavefront model is text; a compiled object file under the same extension is not, and has no kind its name gives.
	["obj", { fallback: "obj", wavefront: "obj", notWavefront: null, mimeHint: true, sniff: "wavefront" }],
	// MicroDVD text unless its head is an MPEG pack header (VobSub images, which no viewer reads). Its MIME type reads as
	// for an unknown extension, as it did before the read existed.
	["sub", { fallback: "sub", vobsub: null, notVobsub: "sub", mimeHint: true, sniff: "vobsub" }],
	// A vCard unless its first line says otherwise (a Variant Call Format file, plain text). As for `.sub`, its MIME type
	// reads as for an unknown extension.
	["vcf", { fallback: "vcf", vcard: "vcf", notVcard: "txt", mimeHint: true, sniff: "vcard" }]
])

function lowerName(name: string): string {
	const trimmed = name.trim()

	return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase()
}

export function isAmbiguousExtension(extension: string): boolean {
	return AMBIGUOUS.has(extension)
}

// The content read that settles `extension`, if it is one a read settles.
export function sniffForExtension(extension: string, table: AmbiguityTable = AMBIGUOUS): SniffId | null {
	return table.get(extension)?.sniff ?? null
}

// What `extension` may turn out to be once its read ran: its usual meaning, and what each of the read's verdicts makes
// it (null: no kind). Empty when no read settles it.
export function sniffCandidates(extension: string, table: AmbiguityTable = AMBIGUOUS): readonly (string | null)[] {
	const ambiguity = table.get(extension)

	if (ambiguity?.sniff === undefined) {
		return []
	}

	const candidates: (string | null)[] = [ambiguity.fallback]

	for (const verdict of SNIFF_VERDICTS[ambiguity.sniff]) {
		const target = verdictExtension(ambiguity, verdict)

		if (target !== undefined) {
			candidates.push(target)
		}
	}

	return candidates
}

// The extension a verdict makes the file, null for no kind, undefined when the verdict says nothing about it.
function verdictExtension(ambiguity: Ambiguity, verdict: FileVerdict): string | null | undefined {
	switch (verdict) {
		case "wordBinary":
			return ambiguity.wordBinary
		case "notWordBinary":
			return ambiguity.notWordBinary
		case "presentationBinary":
			return ambiguity.presentationBinary
		case "notPresentationBinary":
			return ambiguity.notPresentationBinary
		case "virtualDisk":
			return ambiguity.virtualDisk
		case "notVirtualDisk":
			return ambiguity.notVirtualDisk
		case "iworkPackage":
			return ambiguity.iworkPackage
		case "notIworkPackage":
			return ambiguity.notIworkPackage
		case "sqlite":
			return ambiguity.sqlite
		case "notSqlite":
			return ambiguity.notSqlite
		case "pdfCompatible":
			return ambiguity.pdfCompatible
		case "notPdfCompatible":
			return ambiguity.notPdfCompatible
		case "wavefront":
			return ambiguity.wavefront
		case "notWavefront":
			return ambiguity.notWavefront
		case "vobsub":
			return ambiguity.vobsub
		case "notVobsub":
			return ambiguity.notVobsub
		case "vcard":
			return ambiguity.vcard
		case "notVcard":
			return ambiguity.notVcard
		case "transportStream":
			return ambiguity.transportStream
		case "notTransportStream":
			return ambiguity.transportStream === undefined ? undefined : ambiguity.fallback
		case "audio":
			return ambiguity.audio
		case "video":
			return ambiguity.video
	}
}

const AUDIO_TYPE = /^\s*audio\//i
const VIDEO_TYPE = /^\s*video\//i

function isMediaType(mime: string | null | undefined): boolean {
	return mime !== null && mime !== undefined && (AUDIO_TYPE.test(mime) || VIDEO_TYPE.test(mime))
}

const TEXT_TYPE = /^\s*text\//i
const PLAIN_TEXT = "txt"

function mimeExtension(ambiguity: Ambiguity, mime: string | null | undefined): string | undefined {
	if (mime === null || mime === undefined) {
		return undefined
	}

	if (ambiguity.text !== undefined && TEXT_TYPE.test(mime)) {
		return ambiguity.text
	}

	if (ambiguity.mimeHint === false) {
		return undefined
	}

	return AUDIO_TYPE.test(mime) ? ambiguity.audio : VIDEO_TYPE.test(mime) && ambiguity.mimeHint === true ? ambiguity.video : undefined
}

// Whether a content read could still turn the file into another kind.
function sniffable(ambiguity: Ambiguity, base: string, extension: string, size: number | bigint | undefined): boolean {
	if (ambiguity.transportStream === undefined) {
		return true
	}

	const stem = base.slice(0, base.length - extension.length - 1)

	return size !== undefined && Number(size) >= MIN_TRANSPORT_STREAM_BYTES && !stem.endsWith(".d")
}

function fileKind<K>(kind: K | null, extension: string, source: FileKindSource, ambiguous: boolean, canSniff: boolean): FileKind<K> {
	return { kind, extension, source, ambiguous, sniffable: canSniff }
}

// `table`: the ambiguous extensions, this module's own unless a test passes another.
export function resolveFileKind<K>(
	input: FileKindInput,
	kindOf: (extension: string) => K | null,
	table: AmbiguityTable = AMBIGUOUS
): FileKind<K> {
	const base = lowerName(input.name)
	const named = extensionForExactFileName(base)

	// A Makefile is code whatever its type says.
	if (named !== null) {
		return fileKind(kindOf(named), named, "name", false, false)
	}

	const dot = extensionStart(base)
	const own = dot === -1 ? "" : base.slice(dot + 1)
	const ambiguity = table.get(own)
	let canSniff = false

	if (ambiguity !== undefined) {
		const verdict = input.verdict ?? null
		const byVerdict = verdict === null ? undefined : verdictExtension(ambiguity, verdict)

		canSniff = byVerdict === undefined && sniffable(ambiguity, base, own, input.size)

		// A read found it is none of the kinds its extension names.
		if (byVerdict === null) {
			return fileKind<K>(null, own, "sniff", true, false)
		}

		if (byVerdict !== undefined) {
			const kind = kindOf(byVerdict)

			if (kind !== null) {
				return fileKind(kind, byVerdict, "sniff", true, canSniff)
			}
		}

		const byMime = mimeExtension(ambiguity, input.mime)

		if (byMime !== undefined) {
			const kind = kindOf(byMime)

			if (kind !== null) {
				return fileKind(kind, byMime, "mime", true, canSniff)
			}
		}

		if (ambiguity.fallback !== null) {
			const fallbackKind = kindOf(ambiguity.fallback)

			if (fallbackKind !== null) {
				return fileKind(fallbackKind, ambiguity.fallback, "default", true, canSniff)
			}
		}

		// No usual meaning, or none of its meanings is in the table: read it like an unknown extension below.
	} else if (own !== "") {
		const kind = kindOf(own)

		if (kind !== null) {
			return fileKind(kind, own, "extension", false, false)
		}
	}

	const ambiguous = ambiguity !== undefined
	const byName = extensionForFileName(base)

	if (byName !== null) {
		return fileKind(kindOf(byName), byName, "name", ambiguous, canSniff)
	}

	// An audio or video type does not make a `.ts` or `.mts` a media file here either.
	const byMime = extensionForMime(
		ambiguity !== undefined &&
			(ambiguity.mimeHint === false
				? isMediaType(input.mime)
				: ambiguity.mimeHint === "audioOnly" && VIDEO_TYPE.test(input.mime ?? ""))
			? null
			: input.mime
	)

	if (byMime !== null) {
		const kind = kindOf(byMime)

		if (kind !== null) {
			return fileKind(kind, byMime, "mime", ambiguous, canSniff)
		}

		// A text/* type is text, whichever kind of text the table lacks (text/csv where no table lists csv).
		if (byMime !== PLAIN_TEXT && input.mime !== null && input.mime !== undefined && TEXT_TYPE.test(input.mime)) {
			const textKind = kindOf(PLAIN_TEXT)

			if (textKind !== null) {
				return fileKind(textKind, PLAIN_TEXT, "mime", ambiguous, canSniff)
			}
		}
	}

	return fileKind<K>(null, own, "default", ambiguous, canSniff)
}

// Whether `verdict` would change what the file resolves to, or settle a read the app would otherwise run again on every
// open (a `.ts` that may be a stream, a `.key` found to be no Keynote package): worth keeping only then.
export function verdictChangesKind<K>(
	input: Omit<FileKindInput, "verdict">,
	verdict: FileVerdict,
	kindOf: (extension: string) => K | null,
	table: AmbiguityTable = AMBIGUOUS
): boolean {
	const without = resolveFileKind({ ...input, verdict: null }, kindOf, table)

	if (!without.ambiguous) {
		return false
	}

	if (verdict === "notTransportStream") {
		return without.sniffable
	}

	const settled = resolveFileKind({ ...input, verdict }, kindOf, table)
	const settlesRead = without.sniffable && without.source === "default" && sniffForExtension(without.extension, table) !== null

	// A read that found none of its meanings opens no viewer that could read it again.
	return (
		settled.extension !== without.extension ||
		settled.kind !== without.kind ||
		(settlesRead && settled.kind === null && !settled.sniffable)
	)
}
