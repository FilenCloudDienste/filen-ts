import {
	P14_MEDIA_EXT,
	activeFade,
	activeTrim,
	bookmarksXml,
	bookmarkXml,
	fadeXml,
	MEDIA_BOOKMARKS_MAX,
	normalizedMediaTiming,
	parseUniversalTime,
	readBookmark,
	readMediaTiming,
	trimXml,
	type MediaBookmark,
	type MediaTiming
} from "../../../anim/media"
import { refused, type MediaRef, type ShapeNode } from "../../../presentation/model"
import { NodeKind, type XmlDocument } from "../../../xml/index"
import { G, type PartReader } from "../../read/xml"
import { emitPptx } from "../emit"
import type { EmitPiece, PptxEmitFamily } from "../types"
import { Pieces, endTag, readerOf, sameModel, sourceNode, startTag, type EmitContext } from "./shape"

// A medium's trim, fade and bookmarks (MS-PPTX §2.3.3.7 p14:media in the picture's p:nvPr extension list). The media
// family writes the p:pic (emitFamilyOf routes every medium here first); when the model's timing is what the source's
// p14:media reads as, its markup is the media family's as it is. Otherwise the source p14:media is written again: its
// start tag and every child the model does not hold (its own extLst) by span, each of trim, fade and bmkLst kept by
// span when it reads as the model holds it, else written from the model (absent when the model has none). A medium
// an op inserted gets its children inside the p14:media the media family wrote for it.

function mediaOf(shape: ShapeNode): MediaRef | undefined {
	return shape.media ?? (shape.frame?.kind === "media" ? shape.frame.media : undefined)
}

// The p14:media of a source p:pic, else -1.
export function sourceP14Media(r: PartReader, pic: number): number {
	const nvPr = r.child(r.child(pic, G.P, "nvPicPr"), G.P, "nvPr")

	for (const ext of r.children(r.child(nvPr, G.P, "extLst"), G.P, "ext")) {
		if (r.attr(ext, "uri") !== P14_MEDIA_EXT) continue

		const media = r.child(ext, G.P14, "media")

		if (media >= 0) return media
	}

	return -1
}

function sameTiming(a: MediaTiming | undefined, b: MediaTiming | undefined): boolean {
	return sameModel(a === undefined ? undefined : normalizedMediaTiming(a), b === undefined ? undefined : normalizedMediaTiming(b))
}

// p14:media written again: unknown children and unchanged groups by span, in schema order (trim, fade, bmkLst, extLst).
function mediaMarkup(context: EmitContext, r: PartReader, node: number, timing: MediaTiming | undefined): Pieces {
	const document = context.document as XmlDocument
	const prefix = context.copier !== undefined ? "p14" : document.prefix(node)
	const named = (xml: string): string => (prefix === "p14" ? xml : xml.replace(/(<\/?)p14:/gu, prefix === "" ? "$1" : `$1${prefix}:`))
	const normal = timing === undefined ? undefined : normalizedMediaTiming(timing)
	const source = readMediaTiming(r, node)
	const out = new Pieces()
	const written = { trim: false, fade: false, bmkLst: false }
	// A group the model holds is written once, at its schema place: before the first child that follows it.
	const before = (local: "trim" | "fade" | "bmkLst" | "extLst"): void => {
		const order = ["trim", "fade", "bmkLst"] as const

		for (const group of order) {
			if (group === local) break
			if (written[group]) continue

			written[group] = true
			out.text(named(groupXml(group, normal)))
		}
	}

	out.append([startTag(context, node)])

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		const local = r.group(child) === G.P14 ? r.local(child) : ""

		if (local === "trim" || local === "fade" || local === "bmkLst") {
			before(local)
			written[local] = true

			const same =
				local === "trim"
					? sameModel(normal?.trim, activeTrim(source?.trim))
					: local === "fade"
						? sameModel(normal?.fade, activeFade(source?.fade))
						: sameModel(normal?.bookmarks, source?.bookmarks?.length === 0 ? undefined : source?.bookmarks)

			if (same) out.hole(child)
			else if (local === "bmkLst") out.append(bookmarkListPieces(context, r, child, normal?.bookmarks ?? [], named).out)
			else out.text(named(groupXml(local, normal)))
		} else {
			if (local === "extLst") before("extLst")

			out.hole(child)
		}
	}

	before("extLst")

	return out.text(endTag(context, node))
}

// The bookmark list written again with the model's bookmarks, the file's bookmarks the reader could not take (no name,
// a time it cannot read, past the 256th: what readMediaTiming leaves out) kept by span in their places: each after the
// model's bookmarks that come before its time. Nothing is dropped; a list left with nothing goes.
function bookmarkListPieces(
	context: EmitContext,
	r: PartReader,
	list: number,
	bookmarks: readonly MediaBookmark[],
	named: (xml: string) => string
): Pieces {
	const document = context.document as XmlDocument
	const out = new Pieces()
	let taken = 0
	let next = 0
	let kept = 0
	const flush = (beforeMs: number): void => {
		while (next < bookmarks.length && (bookmarks[next]?.timeMs ?? 0) < beforeMs) {
			const bookmark = bookmarks[next++] as MediaBookmark

			out.text(named(bookmarkXml(bookmark)))
		}
	}

	out.append([startTag(context, list)])

	for (let child = document.firstChild(list); child >= 0; child = document.nextSibling(child)) {
		if (r.group(child) !== G.P14 || r.local(child) !== "bmk") {
			if (document.kinds[child] === NodeKind.Element) out.hole(child)

			continue
		}

		const read = taken >= MEDIA_BOOKMARKS_MAX ? undefined : readBookmark(r, child)

		if (read !== undefined) {
			taken++

			continue
		}

		// After the model's bookmarks before its time (a time that does not parse: where it stands).
		const at = parseUniversalTime(r.attr(child, "time"), false)

		if (at !== undefined) flush(at)
		out.hole(child)
		kept++
	}

	flush(Number.POSITIVE_INFINITY)

	if (kept === 0 && bookmarks.length === 0) return new Pieces()

	return out.text(endTag(context, list))
}

function groupXml(group: "trim" | "fade" | "bmkLst", timing: MediaTiming | undefined): string {
	if (group === "trim") return timing?.trim === undefined ? "" : trimXml(timing.trim)
	if (group === "fade") return timing?.fade === undefined ? "" : fadeXml(timing.fade)

	return timing?.bookmarks === undefined ? "" : bookmarksXml(timing.bookmarks)
}

// The source spans of `pieces` with `target` (a descendant of one of their holes) replaced: each hole on its path is
// opened up into its start tag, its children by span (the path's one opened again), and its end tag.
function replaceInside(context: EmitContext, pieces: readonly EmitPiece[], target: number, markup: Pieces): EmitPiece[] | undefined {
	const document = context.document as XmlDocument
	const path = new Set<number>()

	for (let node = target; node >= 0; node = document.parent(node)) path.add(node)

	let found = false
	const open = (node: number, out: Pieces): void => {
		if (node === target) {
			found = true
			out.append(markup.out)

			return
		}

		if (!path.has(node)) {
			out.hole(node)

			return
		}

		out.append([startTag(context, node)])

		for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) open(child, out)

		out.text(endTag(context, node))
	}
	const out = new Pieces()

	for (const piece of pieces) {
		if (typeof piece === "object" && !(piece instanceof Uint8Array)) open(piece.hole, out)
		else out.append([piece])
	}

	return found ? out.out : undefined
}

const NEW_P14_MEDIA = /(<p14:media\b[^>]*?)\s*\/>/u

export const emitPptxMediaTiming: PptxEmitFamily = {
	emit: (request, context) => {
		const shape = request.shape

		const media = shape === undefined ? undefined : mediaOf(shape)

		if (shape === undefined || media === undefined) return refused("failed", "A media timing emit without a medium")

		const inner = emitPptx("media", request, context)

		if (inner.kind !== "markup") return inner

		const emitContext: EmitContext = context
		const r = readerOf(emitContext)
		const source = sourceNode(emitContext, shape.src)
		const p14 = r === undefined || source < 0 ? -1 : sourceP14Media(r, source)
		const timing = media.timing

		if (r !== undefined && p14 >= 0) {
			if (sameTiming(timing, readMediaTiming(r, p14))) return inner

			const pieces = replaceInside(emitContext, inner.pieces, p14, mediaMarkup(emitContext, r, p14, timing))

			return pieces === undefined ? refused("failed", "The medium's p14:media is not in its markup") : { kind: "markup", pieces }
		}

		const children = timing === undefined ? "" : mediaTimingChildren(timing)

		if (children === "") return inner
		// A source medium without p14:media (a PowerPoint 2007 link) has nowhere to hold them; apply refuses those.
		if (source >= 0) return refused("unsupported", "A medium without p14:media cannot hold a trim, fade or bookmarks")

		// A medium an op inserted: its p14:media is the media family's new markup.
		let placed = false
		const pieces = inner.pieces.map(piece => {
			if (placed || typeof piece !== "string" || !NEW_P14_MEDIA.test(piece)) return piece

			placed = true

			return piece.replace(NEW_P14_MEDIA, (_, open: string) => `${open}>${children}</p14:media>`)
		})

		return placed ? { kind: "markup", pieces } : refused("failed", "The new medium's p14:media is not in its markup")
	}
}

function mediaTimingChildren(timing: MediaTiming): string {
	const normal = normalizedMediaTiming(timing)

	if (normal === undefined) return ""

	return groupXml("trim", normal) + groupXml("fade", normal) + groupXml("bmkLst", normal)
}
