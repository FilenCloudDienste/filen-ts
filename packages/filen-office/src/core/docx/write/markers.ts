import type { Node } from "prosemirror-model"
import { NO_SOURCE, type MarkerAttrs, type MarkerKind, type MarkerNodeAttrs } from "../edit/schema"
import { validBookmarkName } from "../fields/bookmarks"
import { Item } from "../model/index"
import type { Out } from "./markup"
import { src } from "./source"
import type { StoryWriting } from "./story"
import { DocxWriteError } from "./values"

// Source items that are range markers (bookmarks, comment ranges, move ranges, permissions).
export const MARKER_ITEMS = new Set<number>([
	Item.BookmarkStart,
	Item.BookmarkEnd,
	Item.CommentRangeStart,
	Item.CommentRangeEnd,
	Item.MoveFromRangeStart,
	Item.MoveFromRangeEnd,
	Item.MoveToRangeStart,
	Item.MoveToRangeEnd,
	Item.PermissionStart,
	Item.PermissionEnd,
	Item.CustomXmlRangeMarker
])

// Writes a range marker without a source: one of a block's marker lists (`node` undefined) or an inline
// marker node.
export interface MarkerWriter {
	readonly kind: MarkerKind
	write(w: StoryWriting, out: Out, marker: MarkerAttrs, node: Node | undefined): void
}

// A new comment range's start or end: the id is checked; Gate 2 checks that a comment has it.
function commentRange(kind: "commentRangeStart" | "commentRangeEnd"): MarkerWriter {
	return {
		kind,
		write(w, out, marker) {
			const id = marker.id

			if (id === null || !/^-?\d{1,10}$/.test(id) || Math.abs(Number(id)) >= 2 ** 31)
				throw new DocxWriteError("missingSource", `A new ${kind} without an id`)

			out.text(w.names.empty(kind, [["id", id]]))
		}
	}
}

// A new bookmark's start (its id and name) or end (its id). Gate 2 checks the names and that each end has a
// start (checks/fields.ts).
function bookmark(kind: "bookmarkStart" | "bookmarkEnd"): MarkerWriter {
	return {
		kind,
		write(w, out, marker, node) {
			const id = marker.id

			if (id === null || !/^\d{1,10}$/.test(id) || Number(id) >= 2 ** 31)
				throw new DocxWriteError("missingSource", `A new ${kind} without an id`)

			if (kind === "bookmarkEnd") {
				out.text(w.names.empty(kind, [["id", id]]))

				return
			}

			const name: unknown = node?.attrs["name"] ?? (marker as Partial<MarkerNodeAttrs>).name

			// Without a valid name there is nothing to write (as before bookmarks were written).
			if (typeof name !== "string" || !validBookmarkName(name))
				throw new DocxWriteError("missingSource", node === undefined ? "A new range marker" : `A new ${node.type.name}`)

			out.text(
				w.names.empty(kind, [
					["id", id],
					["name", name]
				])
			)
		}
	}
}

// The w:id each new move range of a save is written with (by the editor's id): a revision id of the save's own,
// the start's and the end's the same.
const moveIds = new WeakMap<object, Map<string, number>>()

function moveId(w: StoryWriting, key: string): number {
	let ids = moveIds.get(w.env)

	if (ids === undefined) moveIds.set(w.env, (ids = new Map()))

	let id = ids.get(key)

	if (id === undefined) ids.set(key, (id = w.env.nextRevisionId()))

	return id
}

// A new move range recorded while tracking: the start (CT_MoveBookmark: id, name, author, date) or the end.
function moveRange(kind: "moveFromRangeStart" | "moveFromRangeEnd" | "moveToRangeStart" | "moveToRangeEnd"): MarkerWriter {
	const from = kind.startsWith("moveFrom")
	const start = kind.endsWith("Start")

	return {
		kind,
		write(w, out, marker, node) {
			if (marker.id === null) throw new DocxWriteError("missingSource", `A new ${kind} without an id`)

			const id = String(moveId(w, `${from ? "from" : "to"}:${marker.id}`))

			if (!start) {
				out.text(w.names.empty(kind, [["id", id]]))

				return
			}

			const own = (node?.attrs ?? marker) as Partial<MarkerNodeAttrs>
			const name = own.name
			const author = own.author

			if (typeof name !== "string" || name === "" || typeof author !== "string" || author === "")
				throw new DocxWriteError("missingSource", `A new ${kind}`)

			out.text(
				w.names.empty(kind, [
					["id", id],
					["name", name],
					["author", author],
					["date", own.date ?? null]
				])
			)
		}
	}
}

// Writers of new markers by kind; a new marker of any other kind is refused.
const NEW_MARKERS: ReadonlyMap<MarkerKind, MarkerWriter> = new Map(
	[
		commentRange("commentRangeStart"),
		commentRange("commentRangeEnd"),
		bookmark("bookmarkStart"),
		bookmark("bookmarkEnd"),
		moveRange("moveFromRangeStart"),
		moveRange("moveFromRangeEnd"),
		moveRange("moveToRangeStart"),
		moveRange("moveToRangeEnd")
	].map(writer => [writer.kind, writer])
)

// A marker standing before or after blocks (MarkerList).
export function writeListMarker(w: StoryWriting, out: Out, marker: MarkerAttrs): void {
	if (marker.src !== NO_SOURCE) {
		w.copyWhole(out, w.part.node(marker.src))

		return
	}

	const writer = NEW_MARKERS.get(marker.kind)

	if (writer === undefined) throw new DocxWriteError("missingSource", "A new range marker")

	writer.write(w, out, marker, undefined)
}

// A marker node inside a paragraph.
export function writeMarkerAtom(w: StoryWriting, out: Out, node: Node): void {
	const own = src(node)

	if (own !== NO_SOURCE) {
		w.copyNode(out, w.part.node(own))

		return
	}

	const marker: MarkerAttrs = { src: own, kind: node.attrs["kind"] as MarkerKind, id: node.attrs["id"] as string | null }
	const writer = NEW_MARKERS.get(marker.kind)

	if (writer === undefined) throw new DocxWriteError("missingSource", `A new ${node.type.name}`)

	writer.write(w, out, marker, node)
}
