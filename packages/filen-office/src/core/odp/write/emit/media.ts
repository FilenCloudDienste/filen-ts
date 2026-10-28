import { insertedMediaContent, insertedMediaId, insertedMediaWritten, mediaPlayback } from "../../../presentation/edit/apply/media"
import { insertedImage, insertedImageWritten, pictureFillOf } from "../../../presentation/edit/apply/picture"
import type { InsertedImage, MediaPlayback } from "../../../presentation/edit/ops"
import { refused, type Refused, type ShapeNode, type SlideNode } from "../../../presentation/model"
import { escapeAttribute, escapeText } from "../../../xml/index"
import type { EmitResult } from "../../../pptx/write/types"
import type { OdpEmitContext, OdpEmitFamily, OdpStylesApi } from "../emit"
import { boxAttributes, placed } from "./shape"

// The media family's ODF markup: a draw:frame holding a draw:plugin (ODF 1.3 Part 3 §10.4.7, xlink:href to the
// package entry, the parameters LibreOffice reads: Loop, Mute, VolumeDB, Zoom, MediaMimeType) and its poster as a
// draw:image after it (§10.4.2: a consumer shows the first content it supports). A medium the file has is the shape
// family's to move and rename; a medium an op inserted is written whole, its entry stored and streamed once at save
// from where the worker registered it, checked against the CRC-32 taken at insert, under a name no entry of the
// package has. Once a save wrote it (and its poster), the entries it was written to are named instead. Its playback
// options are the plugin's parameters (Loop, Mute, VolumeDB, as LibreOffice reads them), never an anim:audio.

const PLUGIN_MIME = "application/vnd.sun.star.media"
const EXTENSIONS: Readonly<Record<string, string>> = {
	"video/mp4": "mp4",
	"video/quicktime": "mov",
	"video/webm": "webm",
	"video/ogg": "ogv",
	"video/x-msvideo": "avi",
	"video/x-ms-wmv": "wmv",
	"audio/mpeg": "mp3",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"audio/x-wav": "wav",
	"audio/ogg": "ogg",
	"audio/flac": "flac",
	"image/png": "png",
	"image/jpeg": "jpg"
}

function extensionOf(contentType: string, name: string): string {
	const known = EXTENSIONS[contentType.toLowerCase()]

	if (known !== undefined) return known

	const dot = name.lastIndexOf(".")
	const tail = dot > 0 ? name.slice(dot + 1).toLowerCase() : ""

	return /^[a-z0-9]{1,5}$/u.test(tail) ? tail : "bin"
}

function param(name: string, value: string): string {
	return `<draw:param draw:name="${name}" draw:value="${escapeAttribute(value)}"/>`
}

// LibreOffice's quietest volume (avmedia's minimum, dB); a volume of 0 is written as it.
const MIN_VOLUME_DB = -40

// The plugin's VolumeDB of a PresentationML volume (0..100,000, linear), in whole dB.
export function volumeDb(volume: number | undefined): number {
	if (volume === undefined || volume >= 100_000) return 0
	if (volume <= 0) return MIN_VOLUME_DB

	return Math.max(MIN_VOLUME_DB, Math.round(20 * Math.log10(volume / 100_000)))
}

function playbackParams(playback: MediaPlayback): string {
	return (
		param("Loop", playback.loop === true ? "true" : "false") +
		param("Mute", playback.mute === true ? "true" : "false") +
		param("VolumeDB", String(volumeDb(playback.volume)))
	)
}

// The package's entries this save names, per save (a name probed once is the medium's or poster's for the save).
const named = new WeakMap<OdpStylesApi, Map<string, string>>()

// Whether the package written holds `path` (the source's entries and those this save added).
type Probing = OdpStylesApi & { hasEntry(path: string): boolean }

function probing(styles: OdpStylesApi): styles is Probing {
	return "hasEntry" in styles && typeof styles.hasEntry === "function"
}

// `<dir>/<stem><n>.<ext>` with the smallest n no entry of the package has: never a name the file holds already.
function freeName(styles: Probing, key: string, dir: string, stem: string, extension: string): string {
	let names = named.get(styles)

	if (names === undefined) {
		names = new Map()
		named.set(styles, names)
	}

	const known = names.get(key)

	if (known !== undefined) return known

	const taken = new Set(names.values())
	let n = 1

	while (taken.has(`${dir}/${stem}${String(n)}.${extension}`) || styles.hasEntry(`${dir}/${stem}${String(n)}.${extension}`)) n++

	const name = `${dir}/${stem}${String(n)}.${extension}`

	names.set(key, name)

	return name
}

// The medium's entry: the one a save wrote it to (while the package has it), else its bytes added under a free name.
function mediumEntry(context: OdpEmitContext, styles: Probing, id: number): string | Refused {
	const written = insertedMediaWritten(context.deck, id)

	if (written !== undefined && styles.hasEntry(written)) return written

	const content = insertedMediaContent(context.deck, id)

	if (content === undefined) return refused("stale", `The inserted medium ${String(id)} is not held`)

	return styles.addEntry(
		freeName(styles, `media:${String(id)}`, "Media", "media", extensionOf(content.contentType, content.name)),
		content.bytes,
		content.contentType,
		{ compress: false, crc32: content.crc32 }
	)
}

// The entry of inserted medium `id` for another family (a transition's sound): the same entry as the media family's,
// once per save.
export function insertedMediumEntry(context: OdpEmitContext, id: number): string | Refused {
	const styles = context.styles

	return probing(styles) ? mediumEntry(context, styles, id) : refused("failed", "the save's package entries")
}

// The poster's entry, likewise (an inserted image's registry id).
function posterEntry(context: OdpEmitContext, styles: Probing, id: number): string | Refused {
	const written = insertedImageWritten(context.deck, id)

	if (written !== undefined && styles.hasEntry(written.part)) return written.part

	const poster: InsertedImage | undefined = insertedImage(context.deck, id)

	if (poster === undefined) return refused("malformed", "A new medium without a poster")

	return styles.addEntry(
		freeName(styles, `poster:${String(id)}`, "Pictures", "poster", extensionOf(poster.contentType, "")),
		poster.bytes,
		poster.contentType
	)
}

function newMedia(context: OdpEmitContext, slide: SlideNode, shape: ShapeNode, id: number): EmitResult {
	const media = shape.media
	const styles = context.styles
	// The poster: the frame's preview (an ODP deck's insert), or a picture fill (a medium inserted as a pptx picture).
	const posterId = insertedMediaId(media?.poster) ?? pictureFillOf(shape)?.inserted

	if (media === undefined || shape.xfrm === undefined) return refused("malformed", "A new medium without its medium or box")
	if (posterId === undefined) return refused("malformed", "A new medium without a poster")
	if (shape.lock !== undefined) return refused("locked", shape.lock)
	if (!probing(styles)) return refused("notImplemented", "a package whose entries cannot be probed")

	const href = mediumEntry(context, styles, id)

	if (typeof href !== "string") return href

	const image = posterEntry(context, styles, posterId)

	if (typeof image !== "string") return image

	const contentType = insertedMediaContent(context.deck, id)?.contentType ?? media.contentType
	const box = boxAttributes(placed(shape.xfrm, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }))
		.filter(change => change.value !== null)
		.map(change => ` ${change.name}="${escapeAttribute(change.value as string)}"`)
		.join("")
	const alt =
		(shape.alt?.title === undefined || shape.alt.title === "" ? "" : `<svg:title>${escapeText(shape.alt.title)}</svg:title>`) +
		(shape.alt?.descr === undefined || shape.alt.descr === "" ? "" : `<svg:desc>${escapeText(shape.alt.descr)}</svg:desc>`)
	const link = ' xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"'

	return {
		kind: "markup",
		pieces: [
			`<draw:frame${shape.name === "" ? "" : ` draw:name="${escapeAttribute(shape.name)}"`}${shape.hidden ? ' draw:display="none"' : ""}${box}>` +
				`<draw:plugin xlink:href="${escapeAttribute(href)}"${link} draw:mime-type="${PLUGIN_MIME}">` +
				playbackParams(mediaPlayback(slide.timing, shape.id)) +
				param("Zoom", "fit") +
				param("MediaMimeType", contentType) +
				`</draw:plugin><draw:image xlink:href="${escapeAttribute(image)}"${link}/>${alt}</draw:frame>`
		]
	}
}

export const emitOdpMedia: OdpEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		if (shape === undefined) return refused("failed", "A media emit without a shape")

		const id = insertedMediaId(shape.media?.part)

		if (id !== undefined && shape.src === undefined) return newMedia(context, request.slide, shape, id)

		// A medium the file has: its box, name and visibility are the shape family's patch, its plugin stays.
		return refused("notImplemented", "odp emit media content")
	}
}
