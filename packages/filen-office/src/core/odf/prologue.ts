import type { Slicing } from "../slicing"
import { Namespaces, encodeUtf8, parseXml, parseXmlSliced, XmlError, type XmlDocument } from "../xml/index"
import { indexOfBytes, isXmlNameEnd } from "../xml/bytes"
import { OdfNs } from "./namespaces"
import { elementName } from "./tree"

// What comes before office:body in content.xml: office:scripts, office:font-face-decls and
// office:automatic-styles (Part 3 §3.15.3). Style resolution needs only this, so the body (the bulk of the
// stream) is not parsed into a tree here: readers stream it from `bodyStart`.
export interface ContentPrologue {
	// The prologue as a document of its own: the root's start tag, everything up to office:body, the root's end tag.
	readonly document: XmlDocument
	readonly namespaces: Namespaces
	readonly root: number
	// Byte offset of office:body's start tag in the stream, -1 when there is none.
	readonly bodyStart: number
	// The prologue was cut out of the stream (false: the whole stream was parsed, as for UTF-16).
	readonly sliced: boolean
}

const LT = 60
const GT = 62
const SLASH = 47
const QUESTION = 63
const BANG = 33
const DASH = 45
const QUOTE = 34
const APOSTROPHE = 39
const PI_END = encodeUtf8("?>")
const COMMENT_END = encodeUtf8("-->")

// The root element's start, past the declaration, processing instructions, comments and whitespace; -1 when
// the stream has something else there (a DOCTYPE, which the full parse then refuses).
function rootStart(bytes: Uint8Array): number {
	let at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0

	for (;;) {
		at = bytes.indexOf(LT, at)

		if (at < 0) return -1

		const next = bytes[at + 1]

		if (next === QUESTION) {
			const end = indexOfBytes(bytes, PI_END, at + 2)

			if (end < 0) return -1

			at = end + 2
		} else if (next === BANG) {
			if (bytes[at + 2] !== DASH || bytes[at + 3] !== DASH) return -1

			const end = indexOfBytes(bytes, COMMENT_END, at + 4)

			if (end < 0) return -1

			at = end + 3
		} else {
			return at
		}
	}
}

// The byte after a start tag's ">", quotes respected; -1 for an unterminated or self-closing tag.
function startTagEnd(bytes: Uint8Array, start: number): number {
	let quote = 0

	for (let at = start + 1; at < bytes.length; at++) {
		const byte = bytes[at]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === QUOTE || byte === APOSTROPHE) {
			quote = byte
		} else if (byte === GT) {
			return bytes[at - 1] === SLASH ? -1 : at + 1
		}
	}

	return -1
}

function fullPrologue(bytes: Uint8Array): ContentPrologue {
	const document = parseXml(bytes)
	const namespaces = new Namespaces(document)
	const root = document.documentElement()
	let bodyStart = -1

	for (let node = document.firstChildElement(root); node >= 0; node = document.nextSiblingElement(node)) {
		if (elementName(document, namespaces, node) === "office:body") {
			bodyStart = document.start(node)

			break
		}
	}

	return { document, namespaces, root, bodyStart, sliced: false }
}

// Where the root's start tag ends and office:body starts, found without parsing the body; undefined when the
// bytes (a whole stream or a prefix of one) do not show both yet or cannot be read this way (UTF-16, a DOCTYPE,
// a self-closing root, no office namespace binding on the root).
export function locateBody(
	bytes: Uint8Array
): { readonly rootStart: number; readonly openEnd: number; readonly bodyStart: number } | undefined {
	if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) return undefined

	const start = rootStart(bytes)
	const openEnd = start < 0 ? -1 : startTagEnd(bytes, start)

	if (openEnd < 0) return undefined

	let head: XmlDocument

	try {
		head = parseXml(closeRoot(bytes, start, openEnd))
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}

	const prefix = new Namespaces(head).prefixFor(head.documentElement(), OdfNs.office)

	if (prefix === undefined) return undefined

	const needle = encodeUtf8(prefix === "" ? "<body" : `<${prefix}:body`)

	for (let at = indexOfBytes(bytes, needle, openEnd); at >= 0; at = indexOfBytes(bytes, needle, at + 1)) {
		// The byte after the name must be there to tell <office:body from <office:bodyX.
		if (at + needle.length >= bytes.length) return undefined
		if (isXmlNameEnd(bytes[at + needle.length])) return { rootStart: start, openEnd, bodyStart: at }
	}

	return undefined
}

// bytes[0, end) followed by the end tag of the root element starting at `start`.
function closeRoot(bytes: Uint8Array, start: number, end: number): Uint8Array {
	let nameEnd = start + 1

	while (!isXmlNameEnd(bytes[nameEnd])) nameEnd++

	const rootName = bytes.subarray(start + 1, nameEnd)
	const out = new Uint8Array(end + rootName.length + 3)

	out.set(bytes.subarray(0, end))
	out.set([LT, SLASH], end)
	out.set(rootName, end + 2)
	out[out.length - 1] = GT

	return out
}

// The prologue of content.xml, given the whole stream or any prefix of it that reaches past office:body's name.
export function readContentPrologue(bytes: Uint8Array): ContentPrologue {
	const located = locateBody(bytes)

	if (located === undefined) return fullPrologue(bytes)

	try {
		const document = parseXml(closeRoot(bytes, located.rootStart, located.bodyStart))
		const namespaces = new Namespaces(document)
		const root = document.documentElement()

		return { document, namespaces, root, bodyStart: located.bodyStart, sliced: true }
	} catch (error) {
		// The match sat inside a comment or CDATA section of the prologue: parse the whole stream.
		if (error instanceof XmlError) return fullPrologue(bytes)

		throw error
	}
}

// readContentPrologue with the parse in slices (a long prologue holds thousands of automatic styles).
export async function readContentPrologueSliced(bytes: Uint8Array, slicing: Slicing): Promise<ContentPrologue> {
	const located = locateBody(bytes)

	if (located === undefined) return fullPrologue(bytes)

	try {
		const document = await parseXmlSliced(closeRoot(bytes, located.rootStart, located.bodyStart), slicing)
		const namespaces = new Namespaces(document)
		const root = document.documentElement()

		return { document, namespaces, root, bodyStart: located.bodyStart, sliced: true }
	} catch (error) {
		if (error instanceof XmlError) return fullPrologue(bytes)

		throw error
	}
}
