import { locateBody } from "../../odf/index"
import { decodeUtf8, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"

// content.xml of a presentation, cut into its pages without building a tree of the whole stream (ODF 1.3 Part 3
// §10.1.4 office:presentation, §10.2.4 draw:page): one pass over the bytes records each draw:page's byte span, and
// a page is parsed on its own when it is first needed, as a fragment document: the root's start tag, the page (with
// the namespace declarations of its other ancestors copied onto it, so every namespace it uses is declared), the
// root's end tag. Pages are found by namespace, whatever the prefix and wherever it is declared. Everything of the body outside the pages
// (presentation:footer-decl and the other declarations, presentation:settings with the custom shows) is parsed once,
// as a skeleton with the pages cut out. Comments, CDATA sections and processing instructions are skipped, so a
// "<draw:page" inside one is not a page.

const LT = 0x3c
const GT = 0x3e
const SLASH = 0x2f
const QUOTE = 0x22
const APOSTROPHE = 0x27

export interface PageSpan {
	// Byte offsets in content.xml: the page's "<", the byte after its end tag's ">".
	readonly start: number
	readonly end: number
	// Where the start tag's ">" or "/>" is, and the namespace declarations of the page's ancestors inside the root,
	// inserted there when the page is parsed alone (attributes after the page's own, so its node indexes hold).
	readonly insertAt: number
	readonly inject?: Uint8Array
	// The page's start tag alone, self-closed, inside the root (its attributes: name, style, master, layout).
	readonly head: XmlDocument
}

export interface ContentPages {
	readonly bytes: Uint8Array
	readonly pages: readonly PageSpan[]
	// The body without its pages (declarations and settings), parsed.
	readonly skeleton: XmlDocument
	// The root's start tag ("<office:document-content xmlns:…>") and end tag, for fragments.
	readonly rootOpen: Uint8Array
	readonly rootClose: Uint8Array
}

function isNameEnd(byte: number | undefined): boolean {
	return byte === undefined || byte === 32 || byte === 9 || byte === 10 || byte === 13 || byte === GT || byte === SLASH
}

function indexOf(bytes: Uint8Array, text: string | Uint8Array, from: number): number {
	const needle = typeof text === "string" ? encodeUtf8(text) : text
	const first = needle[0] ?? 0

	for (let at = bytes.indexOf(first, from); at >= 0; at = bytes.indexOf(first, at + 1)) {
		let k = 1

		while (k < needle.length && bytes[at + k] === needle[k]) k++

		if (k === needle.length) return at
	}

	return -1
}

// The byte after a start tag's ">" (quotes respected) and whether it closed itself; undefined when unterminated.
function tagEnd(bytes: Uint8Array, start: number): { readonly end: number; readonly selfClosing: boolean } | undefined {
	let quote = 0

	for (let at = start + 1; at < bytes.length; at++) {
		const byte = bytes[at]

		if (quote !== 0) {
			if (byte === quote) quote = 0
		} else if (byte === QUOTE || byte === APOSTROPHE) {
			quote = byte
		} else if (byte === GT) {
			return { end: at + 1, selfClosing: bytes[at - 1] === SLASH }
		}
	}

	return undefined
}

// Past a comment, CDATA section or processing instruction starting at `at` ("<!", "<?"); `at` + 1 for any other tag.
function skipSpecial(bytes: Uint8Array, at: number): number {
	const next = bytes[at + 1]

	if (next === 0x21) {
		if (bytes[at + 2] === 0x2d && bytes[at + 3] === 0x2d) {
			const end = indexOf(bytes, "-->", at + 4)

			return end < 0 ? bytes.length : end + 3
		}

		if (bytes[at + 2] === 0x5b) {
			const end = indexOf(bytes, "]]>", at + 3)

			return end < 0 ? bytes.length : end + 3
		}
	}

	if (next === 0x3f) {
		const end = indexOf(bytes, "?>", at + 2)

		return end < 0 ? bytes.length : end + 2
	}

	return at + 1
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
	let length = 0

	for (const part of parts) length += part.length

	const out = new Uint8Array(length)
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

const XMLNS = encodeUtf8("xmlns")
const DRAWING_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
const PAGE = encodeUtf8("page")
// Namespace declarations of the body's elements outside the pages that differ from the root's and are in scope at
// once: each is copied onto every page's start tag, so the bound is what a page fragment can grow by.
const MAX_INHERITED_DECLARATIONS = 1024

// The namespace declarations of one start tag (bytes [start, end), ">" or "/>" included) as prefix → URI ("" for
// the default namespace); undefined when it declares none.
function declarations(bytes: Uint8Array, start: number, end: number, selfClosing: boolean): Map<string, string> | undefined {
	if (indexOf(bytes.subarray(start, end), XMLNS, 0) < 0) return undefined

	const tag = bytes.subarray(start, end)
	const document = parseXml(selfClosing ? tag : concat(tag.subarray(0, tag.length - 1), encodeUtf8("/>")))
	let found: Map<string, string> | undefined

	for (const { name, value } of document.attributes(document.documentElement())) {
		if (name !== "xmlns" && !name.startsWith("xmlns:")) continue

		found ??= new Map()
		found.set(name === "xmlns" ? "" : name.slice(6), value)
	}

	return found
}

export class ScanError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ScanError"
	}
}

// The pages of content.xml; `limit` refuses a deck of more pages (checked while scanning).
export function scanPages(bytes: Uint8Array, limit: number, refuse: (count: number) => never): ContentPages {
	const located = locateBody(bytes)

	if (located === undefined) throw new ScanError("content.xml has no office:body")

	const rootOpen = bytes.slice(located.rootStart, located.openEnd)
	let nameEnd = located.rootStart + 1

	while (!isNameEnd(bytes[nameEnd])) nameEnd++

	const rootName = bytes.subarray(located.rootStart + 1, nameEnd)
	const rootClose = concat(new Uint8Array([LT, SLASH]), rootName, new Uint8Array([GT]))
	const pages: PageSpan[] = []
	const skeletonParts: Uint8Array[] = [rootOpen]
	let copied = located.bodyStart
	// The namespace scope of the body outside the pages (Namespaces in XML 1.0 §6.1): each prefix's bindings, innermost
	// last, the prefixes each open element declared, and the bindings that differ from the root's (copied onto pages).
	const rootScope = declarations(rootOpen, 0, rootOpen.length, false) ?? new Map<string, string>()
	const bindings = new Map<string, string[]>()
	const frames: (readonly string[])[] = []
	const inherited = new Map<string, string>()
	let inject: Uint8Array | undefined
	let injectStale = false

	for (const [prefix, uri] of rootScope) bindings.set(prefix, [uri])

	const rebind = (prefix: string): void => {
		const uri = bindings.get(prefix)?.at(-1)

		if (uri === rootScope.get(prefix)) inherited.delete(prefix)
		else inherited.set(prefix, uri ?? "")

		if (inherited.size > MAX_INHERITED_DECLARATIONS) throw new ScanError("Too many namespace declarations around the pages")

		injectStale = true
	}
	const injection = (): Uint8Array | undefined => {
		if (injectStale) {
			let text = ""

			for (const [prefix, uri] of inherited) text += ` ${prefix === "" ? "xmlns" : `xmlns:${prefix}`}="${escapeAttribute(uri)}"`

			inject = text === "" ? undefined : encodeUtf8(text)
			injectStale = false
		}

		return inject
	}

	for (let at = bytes.indexOf(LT, located.bodyStart); at >= 0 && at < bytes.length; at = bytes.indexOf(LT, at)) {
		const next = bytes[at + 1]

		if (next === 0x21 || next === 0x3f) {
			at = skipSpecial(bytes, at)

			continue
		}

		if (next === SLASH) {
			// An element of the body outside the pages ends (a mismatch is the skeleton parse's to refuse).
			for (const prefix of frames.pop() ?? []) {
				bindings.get(prefix)?.pop()
				rebind(prefix)
			}

			at++

			continue
		}

		const tag = tagEnd(bytes, at)

		if (tag === undefined) throw new ScanError("An unterminated start tag")

		let nameEnd = at + 1

		while (!isNameEnd(bytes[nameEnd])) nameEnd++

		const own = declarations(bytes, at, tag.end, tag.selfClosing)
		let isPage = nameEnd - at - 1 >= PAGE.length

		for (let k = 0; k < PAGE.length && isPage; k++) if (bytes[nameEnd - PAGE.length + k] !== PAGE[k]) isPage = false

		const prefixEnd = nameEnd - PAGE.length - 1

		if (isPage && prefixEnd > at && bytes[prefixEnd] !== 0x3a) isPage = false

		if (isPage) {
			const prefix = prefixEnd > at ? decodeUtf8(bytes, at + 1, prefixEnd) : ""

			isPage = (own?.get(prefix) ?? bindings.get(prefix)?.at(-1)) === DRAWING_NAMESPACE
		}

		if (!isPage) {
			if (!tag.selfClosing) {
				const declared = own === undefined ? [] : [...own.keys()]

				for (const prefix of declared) {
					let stack = bindings.get(prefix)

					if (stack === undefined) {
						stack = []
						bindings.set(prefix, stack)
					}

					stack.push(own?.get(prefix) ?? "")
					rebind(prefix)
				}

				frames.push(declared)
			}

			at = tag.end

			continue
		}

		let end = tag.end

		if (!tag.selfClosing) {
			// Pages do not nest: the page ends at the first end tag of its name outside comments and CDATA, compared in
			// place, so the page is read once.
			const nameLength = nameEnd - at - 1
			let found = -1

			for (let scan = bytes.indexOf(LT, tag.end); scan >= 0; scan = bytes.indexOf(LT, scan)) {
				const after = bytes[scan + 1]

				if (after === 0x21 || after === 0x3f) {
					scan = skipSpecial(bytes, scan)

					continue
				}

				if (after === SLASH && isNameEnd(bytes[scan + 2 + nameLength])) {
					let k = 0

					while (k < nameLength && bytes[scan + 2 + k] === bytes[at + 1 + k]) k++

					if (k === nameLength) {
						const closeEnd = bytes.indexOf(GT, scan)

						found = closeEnd < 0 ? bytes.length : closeEnd + 1

						break
					}
				}

				scan++
			}

			if (found < 0) throw new ScanError("An unterminated draw:page")

			end = found
		}

		if (pages.length >= limit) refuse(pages.length + 1)

		// Declarations of the ancestors between the root and the page that the page does not make itself.
		let extra = injection()

		if (extra !== undefined && own !== undefined) {
			let text = ""

			for (const [prefix, uri] of inherited)
				if (!own.has(prefix)) text += ` ${prefix === "" ? "xmlns" : `xmlns:${prefix}`}="${escapeAttribute(uri)}"`

			extra = text === "" ? undefined : encodeUtf8(text)
		}

		const insertAt = tag.end - (tag.selfClosing ? 2 : 1)
		const head = extra === undefined ? bytes.subarray(at, insertAt) : concat(bytes.subarray(at, insertAt), extra)

		pages.push({
			start: at,
			end,
			insertAt,
			...(extra === undefined ? {} : { inject: extra }),
			head: parseXml(concat(rootOpen, head, encodeUtf8("/>"), rootClose))
		})
		skeletonParts.push(bytes.subarray(copied, at))
		copied = end
		at = end
	}

	skeletonParts.push(bytes.subarray(copied))

	return { bytes, pages, skeleton: parseXml(concat(...skeletonParts)), rootOpen, rootClose }
}

// One page as a document of its own (its node indexes are the fragment's: SourceRef.fragment = span.start).
export function pageFragment(content: ContentPages, span: PageSpan): XmlDocument {
	const { bytes, rootOpen, rootClose } = content

	if (span.inject === undefined) return parseXml(concat(rootOpen, bytes.subarray(span.start, span.end), rootClose))

	return parseXml(
		concat(rootOpen, bytes.subarray(span.start, span.insertAt), span.inject, bytes.subarray(span.insertAt, span.end), rootClose)
	)
}
