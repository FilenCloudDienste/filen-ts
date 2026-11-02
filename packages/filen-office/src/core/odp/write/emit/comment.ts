import {
	commentTime,
	odfParagraphs,
	slideComments,
	threadOrder,
	type CommentEntry,
	type SlideComments
} from "../../../presentation/comments"
import { parseInScope } from "../../../presentation/edit/canonical"
import { refused, type Deck, type SlideNode } from "../../../presentation/model"
import { decodeUtf8, encodeUtf8, escapeAttribute, escapeText, type XmlEditor } from "../../../xml/index"
import { ANNOTATION, isAnnotation } from "../../read/annotations"
import type { Fragment } from "../../read/context"
import type { OdpEmitFamily } from "../emit"

// A page's comments as LibreOffice reads and writes them on draw pages: officeooo:annotation, last in the page, with
// its place (svg:x, svg:y), author (dc:creator), date (dc:date) and one text:p per line. The page's annotations are
// edited in place: those the session still holds as read stay byte for byte, the ones it no longer has go, new and
// changed ones go in at their place in the session's order, so an undo after a save gives the page back as it was. A
// changed annotation keeps its own attributes and author lines; its paragraphs are written anew.

const OFFICEOOO = "http://openoffice.org/2009/office"
const DC = "http://purl.org/dc/elements/1.1/"
const TEXT = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
const SVG = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
const EMU_PER_CM = 360_000

export const emitOdpComment: OdpEmitFamily = {
	emit: request => (request.shape === undefined ? { kind: "unchanged" } : refused("unsupported", "odp emit comment: a shape"))
}

function cm(emu: number): string {
	return `${String(Math.round((emu / EMU_PER_CM) * 1000) / 1000)}cm`
}

function bindings(scope: ReadonlyMap<string, string>): string {
	let out = ""

	for (const [prefix, uri] of [
		["officeooo", OFFICEOOO],
		["dc", DC],
		["text", TEXT],
		["svg", SVG]
	] as const) {
		if (scope.get(prefix) !== uri) out += ` xmlns:${prefix}="${uri}"`
	}

	return out
}

// An annotation the session made or changed.
function annotationMarkup(entry: CommentEntry, held: SlideComments, scope: ReadonlyMap<string, string>): string {
	const text = odfParagraphs(entry.text)

	if (entry.source !== undefined) {
		const { document, node } = parseInScope(entry.source, held.scope)
		let head = `<${document.name(node)}`

		for (const attribute of document.attributes(node)) head += ` ${attribute.name}="${escapeAttribute(attribute.value)}"`

		let out = `${head}${bindings(scope)}>`

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "creator" || local === "date" || local === "creator-initials" || local === "date-string")
				out += decodeUtf8(document.raw(child))
		}

		return `${out}${text}</${document.name(node)}>`
	}

	const at = entry.anchor
	const place = at?.x === undefined || at.y === undefined ? "" : ` svg:x="${cm(at.x)}" svg:y="${cm(at.y)}"`
	const created = commentTime(entry.created)

	return (
		`<${ANNOTATION}${bindings(scope)}${place}><dc:creator>${escapeText(entry.author)}</dc:creator>` +
		(created === "" ? "" : `<dc:date>${escapeText(created)}</dc:date>`) +
		`${text}</${ANNOTATION}>`
	)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false

	return true
}

// The page's annotations made the session's, in its order.
export function spliceOdpComments(deck: Deck, slide: SlideNode, fragment: Fragment, page: number, editor: XmlEditor): void {
	const held = slideComments(deck, slide.ref)

	if (held === undefined) return

	const document = fragment.document
	const elements: number[] = []

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (isAnnotation(fragment, child)) elements.push(child)
	}

	const scope = fragment.namespaces.inScope(page)
	const wanted = threadOrder(held.entries).map(entry =>
		!entry.changed && entry.source !== undefined ? entry.source : encodeUtf8(annotationMarkup(entry, held, scope))
	)
	let i = 0

	for (const bytes of wanted) {
		let match = -1

		for (let k = i; k < elements.length; k++) {
			if (sameBytes(document.raw(elements[k] as number), bytes)) {
				match = k
				break
			}
		}

		if (match >= 0) {
			for (let k = i; k < match; k++) editor.remove(elements[k] as number)

			i = match + 1
			continue
		}

		const next = elements[i]

		if (next === undefined) editor.append(page, bytes)
		else editor.insertBefore(next, bytes)
	}

	for (let k = i; k < elements.length; k++) editor.remove(elements[k] as number)
}

// A new page's annotations (the page written from the model).
export function odpNewPageAnnotations(deck: Deck, slide: SlideNode, scope: ReadonlyMap<string, string>): string {
	const held = slideComments(deck, slide.ref)

	if (held === undefined) return ""

	return threadOrder(held.entries)
		.map(entry => (!entry.changed && entry.source !== undefined ? decodeUtf8(entry.source) : annotationMarkup(entry, held, scope)))
		.join("")
}
