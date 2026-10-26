import { extensionStart } from "./fileExtensions"
import { extensionForFileName, extensionForMime } from "./fileType"
import { MIN_TRANSPORT_STREAM_BYTES } from "./videos/transportStream"

export { MIN_TRANSPORT_STREAM_BYTES }

// What kind of file something is, decided in one place for both apps, from what is at hand without a
// read: its extension, a content verdict an earlier read left behind, its stored MIME type, a well-known
// file name. The kind itself is each app's (what it can show differs by platform): the app passes
// `kindOf`, its own extension table, and this decides which extension that table is asked about.
//
// 1. A known extension that means one thing wins.
// 2. An extension that means two (`.ts` TypeScript or an MPEG transport stream; `.webm`, `.ogg`, `.mp4`,
//    `.mkv` and their audio siblings; `.dot` a Word 97–2003 template or a Graphviz/text file; `.pot` a PowerPoint
//    97–2003 template or a gettext template) is settled by a content verdict for the file when one exists, else by
//    a MIME type that says audio or video (text, for a `.dot` or `.pot`), else by its usual meaning. A MIME type never makes a `.ts` a
//    video: browsers upload TypeScript as video/mp2t too.
// 3. No or an unknown extension: a well-known name (a Makefile is code whatever its type says), else its MIME
//    type, else unknown.
// Whatever a verdict or a MIME type points at, an extension the caller's table does not know is passed over
// for the next candidate: an app that has no audio Matroska keeps showing an `.mkv` as video. An extension
// none of whose meanings the table knows is read as in 3 (an `.ogg` typed audio/opus on a table without
// Ogg is Opus), but a `.ts` or `.mts` is still never made a media file by its type.

// What a read of the file's content found.
export type ContentVerdict = "transportStream" | "notTransportStream" | "video" | "audio"

// What a read of a `.dot` (or a `.pot`) found: a Word (PowerPoint) binary compound file ([MS-CFB] signature) or not.
// Kept apart from the media verdicts the apps persist.
export type DocumentVerdict = "wordBinary" | "notWordBinary" | "presentationBinary" | "notPresentationBinary"

export type FileVerdict = ContentVerdict | DocumentVerdict

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

interface Ambiguity {
	// The usual meaning.
	fallback: string
	audio?: string
	video?: string
	transportStream?: string
	wordBinary?: string
	notWordBinary?: string
	presentationBinary?: string
	notPresentationBinary?: string
	// What a text/* MIME type makes it.
	text?: string
	// Whether a MIME type may settle it.
	mimeHint: boolean
}

const TRANSPORT_STREAM = "m2ts"

const AMBIGUOUS: ReadonlyMap<string, Ambiguity> = new Map([
	["ts", { fallback: "ts", transportStream: TRANSPORT_STREAM, mimeHint: false }],
	["mts", { fallback: "mts", transportStream: TRANSPORT_STREAM, mimeHint: false }],
	["ogg", { fallback: "ogg", audio: "oga", video: "ogv", mimeHint: true }],
	["oga", { fallback: "oga", audio: "oga", video: "ogv", mimeHint: true }],
	["ogv", { fallback: "ogv", audio: "oga", video: "ogv", mimeHint: true }],
	["webm", { fallback: "webm", audio: "weba", video: "webm", mimeHint: true }],
	["weba", { fallback: "weba", audio: "weba", video: "webm", mimeHint: true }],
	["mp4", { fallback: "mp4", audio: "m4a", video: "mp4", mimeHint: true }],
	["m4a", { fallback: "m4a", audio: "m4a", video: "mp4", mimeHint: true }],
	["mkv", { fallback: "mkv", audio: "mka", video: "mkv", mimeHint: true }],
	["mka", { fallback: "mka", audio: "mka", video: "mkv", mimeHint: true }],
	["dot", { fallback: "dot", wordBinary: "dot", notWordBinary: "txt", text: "txt", mimeHint: false }],
	["pot", { fallback: "pot", presentationBinary: "pot", notPresentationBinary: "txt", text: "txt", mimeHint: false }]
])

function lowerName(name: string): string {
	const trimmed = name.trim()

	return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase()
}

export function isAmbiguousExtension(extension: string): boolean {
	return AMBIGUOUS.has(extension)
}

function verdictExtension(ambiguity: Ambiguity, verdict: FileVerdict): string | undefined {
	switch (verdict) {
		case "wordBinary":
			return ambiguity.wordBinary
		case "notWordBinary":
			return ambiguity.notWordBinary
		case "presentationBinary":
			return ambiguity.presentationBinary
		case "notPresentationBinary":
			return ambiguity.notPresentationBinary
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

function mimeExtension(ambiguity: Ambiguity, mime: string | null | undefined): string | undefined {
	if (mime === null || mime === undefined) {
		return undefined
	}

	if (ambiguity.text !== undefined && TEXT_TYPE.test(mime)) {
		return ambiguity.text
	}

	if (!ambiguity.mimeHint) {
		return undefined
	}

	return AUDIO_TYPE.test(mime) ? ambiguity.audio : VIDEO_TYPE.test(mime) ? ambiguity.video : undefined
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

export function resolveFileKind<K>(input: FileKindInput, kindOf: (extension: string) => K | null): FileKind<K> {
	const base = lowerName(input.name)
	const dot = extensionStart(base)
	const own = dot === -1 ? "" : base.slice(dot + 1)
	const ambiguity = AMBIGUOUS.get(own)
	let canSniff = false

	if (ambiguity !== undefined) {
		const verdict = input.verdict ?? null
		const byVerdict = verdict === null ? undefined : verdictExtension(ambiguity, verdict)

		canSniff = byVerdict === undefined && sniffable(ambiguity, base, own, input.size)

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

		const fallbackKind = kindOf(ambiguity.fallback)

		if (fallbackKind !== null) {
			return fileKind(fallbackKind, ambiguity.fallback, "default", true, canSniff)
		}

		// None of its meanings is in the table: read it like an unknown extension below.
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
	const byMime = extensionForMime(ambiguity !== undefined && !ambiguity.mimeHint && isMediaType(input.mime) ? null : input.mime)

	if (byMime !== null) {
		const kind = kindOf(byMime)

		if (kind !== null) {
			return fileKind(kind, byMime, "mime", ambiguous, canSniff)
		}
	}

	return fileKind<K>(null, own, "default", ambiguous, canSniff)
}

// Whether `verdict` would change what the file resolves to, or settle a `.ts` a content read would otherwise
// still have to: worth keeping only then.
export function verdictChangesKind<K>(
	input: Omit<FileKindInput, "verdict">,
	verdict: FileVerdict,
	kindOf: (extension: string) => K | null
): boolean {
	const without = resolveFileKind({ ...input, verdict: null }, kindOf)

	if (!without.ambiguous) {
		return false
	}

	if (verdict === "notTransportStream") {
		return without.sniffable
	}

	return resolveFileKind({ ...input, verdict }, kindOf).extension !== without.extension
}
