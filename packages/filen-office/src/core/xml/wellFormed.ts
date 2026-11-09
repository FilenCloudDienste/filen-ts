import { NodeKind, PAIRWISE_DUPLICATE_LIMIT, type XmlDocument } from "./document"
import { decodeCharacterData } from "./entities"
import { XmlError } from "./errors"
import { Namespaces, XML_NAMESPACE, XMLNS_NAMESPACE } from "./namespaces"
import { sliceClock, type Slicing } from "../slicing"
import { decodeUtf8 } from "./utf8"

// XML 1.0 (fifth edition) NameStartChar, without ":" (namespaces give it its own role).
function isNameStart(code: number): boolean {
	return (
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x41 && code <= 0x5a) ||
		code === 0x5f ||
		(code >= 0xc0 && code <= 0xd6) ||
		(code >= 0xd8 && code <= 0xf6) ||
		(code >= 0xf8 && code <= 0x2ff) ||
		(code >= 0x370 && code <= 0x37d) ||
		(code >= 0x37f && code <= 0x1fff) ||
		code === 0x200c ||
		code === 0x200d ||
		(code >= 0x2070 && code <= 0x218f) ||
		(code >= 0x2c00 && code <= 0x2fef) ||
		(code >= 0x3001 && code <= 0xd7ff) ||
		(code >= 0xf900 && code <= 0xfdcf) ||
		(code >= 0xfdf0 && code <= 0xfffd) ||
		(code >= 0x10000 && code <= 0xeffff)
	)
}

function isNameChar(code: number): boolean {
	return (
		isNameStart(code) ||
		code === 0x2d ||
		code === 0x2e ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0xb7 ||
		(code >= 0x300 && code <= 0x36f) ||
		code === 0x203f ||
		code === 0x2040
	)
}

// A namespace QName: an NCName, optionally prefixed by another and one colon.
function isQualifiedName(name: string): boolean {
	let partStart = true
	let colons = 0

	for (const char of name) {
		const code = char.codePointAt(0) ?? 0

		if (code === 0x3a) {
			if (partStart || ++colons > 1) return false

			partStart = true
		} else if (partStart ? isNameStart(code) : isNameChar(code)) {
			partStart = false
		} else {
			return false
		}
	}

	return !partStart
}

// Bytes and nodes checked between looks at the clock.
const CHARACTER_STEP = 1 << 18
const NODE_STEP = 1 << 12

// Every byte of the part is valid UTF-8 and every character an XML Char: no C0 controls other than tab and
// line ends, no surrogates, no U+FFFE or U+FFFF.
function* assertCharacters(bytes: Uint8Array, due: () => boolean): Generator<void, void> {
	const length = bytes.length

	for (let i = 0, check = CHARACTER_STEP; i < length;) {
		if (i >= check) {
			check = i + CHARACTER_STEP

			if (due()) yield
		}

		const b0 = bytes[i] ?? 0

		if (b0 < 0x80) {
			if (b0 < 0x20 && b0 !== 9 && b0 !== 10 && b0 !== 13) throw new XmlError("invalidCharacter", "Control character", i)

			i++

			continue
		}

		let code = -1
		let size = 1

		if (b0 >= 0xc2 && b0 <= 0xdf) {
			size = 2
			code = b0 & 0x1f
		} else if (b0 >= 0xe0 && b0 <= 0xef) {
			size = 3
			code = b0 & 0x0f
		} else if (b0 >= 0xf0 && b0 <= 0xf4) {
			size = 4
			code = b0 & 0x07
		}

		for (let k = 1; k < size && code >= 0; k++) {
			const b = bytes[i + k] ?? 0

			code = (b & 0xc0) === 0x80 ? (code << 6) | (b & 0x3f) : -1
		}

		const minimum = size === 2 ? 0x80 : size === 3 ? 0x800 : 0x10000

		if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
			throw new XmlError("invalidCharacter", "Invalid UTF-8, or a character XML does not allow", i)
		}

		i += size
	}
}

function assertName(name: string, offset: number): void {
	if (!isQualifiedName(name)) throw new XmlError("invalidName", `Invalid name "${name}"`, offset)
}

function assertDeclarations(namespaces: Namespaces): void {
	for (const [node, bindings] of namespaces.declarations()) {
		const offset = namespaces.document.start(node)

		for (const [prefix, uri] of bindings) {
			if (prefix === "xmlns") throw new XmlError("unboundPrefix", "The xmlns prefix cannot be declared", offset)
			if (prefix === "xml" && uri !== XML_NAMESPACE) throw new XmlError("unboundPrefix", "The xml prefix is reserved", offset)

			if (prefix !== "xml" && (uri === XML_NAMESPACE || uri === XMLNS_NAMESPACE)) {
				throw new XmlError("unboundPrefix", "A reserved namespace bound to another prefix", offset)
			}

			// Undeclaring a prefix is XML 1.1; XML 1.0 only lets the default namespace be emptied.
			if (prefix !== "" && uri === "") throw new XmlError("unboundPrefix", `Prefix ${prefix} bound to the empty URI`, offset)
		}
	}
}

interface AttributeName {
	readonly prefix: string
	readonly local: string
}

// Attribute names checked once per distinct byte sequence: a part repeats a few dozen names thousands of
// times, so neither decoding nor validating happens per attribute.
class AttributeNames {
	private readonly bytes: Uint8Array
	private readonly buckets = new Map<number, number[]>()
	private readonly starts: number[] = []
	private readonly lengths: number[] = []
	private readonly names: AttributeName[] = []

	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	get(start: number, end: number): AttributeName {
		const bytes = this.bytes
		let hash = end - start

		for (let i = start; i < end; i++) hash = (Math.imul(hash, 31) + (bytes[i] ?? 0)) | 0

		const bucket = this.buckets.get(hash)

		for (const id of bucket ?? []) {
			const from = this.starts[id] ?? 0

			if (this.lengths[id] !== end - start) continue

			let same = true

			for (let k = 0; k < end - start && same; k++) same = bytes[from + k] === bytes[start + k]

			if (same) return this.names[id] ?? { prefix: "", local: "" }
		}

		const name = decodeUtf8(bytes, start, end)

		assertName(name, start)

		const colon = name.indexOf(":")
		const entry = { prefix: colon < 0 ? "" : name.slice(0, colon), local: name.slice(colon + 1) }

		this.names.push(entry)
		this.starts.push(start)
		this.lengths.push(end - start)

		if (bucket === undefined) {
			this.buckets.set(hash, [this.names.length - 1])
		} else {
			bucket.push(this.names.length - 1)
		}

		return entry
	}
}

function hasReference(bytes: Uint8Array, start: number, end: number): boolean {
	for (let i = start; i < end; i++) {
		if (bytes[i] === 38) return true
	}

	return false
}

// Everything parseXml leaves unchecked, run on a part before it is written so an edit can never save
// markup the next reader rejects: UTF-8 and characters, names, attribute syntax and duplicates (also by
// expanded name), references, "--" in comments, "]]>" in text, and that every prefix is declared.
export function assertWellFormed(document: XmlDocument): void {
	const steps = wellFormed(document, () => false)

	while (steps.next().done !== true);
}

// assertWellFormed in slices, giving the host a turn whenever the slice is used up.
export async function assertWellFormedSliced(document: XmlDocument, slicing: Slicing): Promise<void> {
	const clock = sliceClock(slicing)
	const steps = wellFormed(document, () => clock.due, await Namespaces.sliced(document, {}, clock))

	while (steps.next().done !== true) await clock.pause()
}

function* wellFormed(document: XmlDocument, due: () => boolean, scanned?: Namespaces): Generator<void, void> {
	const { bytes, kinds, starts, ends, nameIds, count } = document

	if (due()) yield

	yield* assertCharacters(bytes, due)

	for (const name of document.names) assertName(name, -1)

	if (due()) yield

	const namespaces = scanned ?? new Namespaces(document)
	const attributeNames = new AttributeNames(bytes)
	const elementPrefixes: (string | undefined)[] = []
	// Expanded names of one element's prefixed attributes, reused across elements.
	const uris: string[] = []
	const locals: string[] = []
	// Past PAIRWISE_DUPLICATE_LIMIT prefixed attributes, the same expanded names keyed "uri\0local".
	const expanded = new Set<string>()

	assertDeclarations(namespaces)

	for (let node = 1; node < count; node++) {
		if ((node & (NODE_STEP - 1)) === 0 && due()) yield

		const kind = kinds[node]
		const start = starts[node] ?? 0
		const end = ends[node] ?? 0

		if (kind === NodeKind.Element) {
			const id = nameIds[node] ?? 0
			let prefix = elementPrefixes[id]

			if (prefix === undefined) {
				prefix = document.prefix(node)
				elementPrefixes[id] = prefix
			}

			// The xmlns prefix only ever names declarations, never an element.
			if (prefix === "xmlns") throw new XmlError("unboundPrefix", "Element with the reserved xmlns prefix", start)

			if (prefix !== "" && namespaces.uri(node, prefix) === undefined) {
				throw new XmlError("unboundPrefix", `Prefix ${prefix} is not declared`, start)
			}

			const spans = document.attributeSpans(node)

			uris.length = 0
			locals.length = 0

			let hashed = false

			if (expanded.size > 0) expanded.clear()

			for (let k = 0; k < spans.length; k += 4) {
				const nameStart = spans[k] ?? 0
				const valueStart = spans[k + 2] ?? 0
				const valueEnd = spans[k + 3] ?? 0
				const name = attributeNames.get(nameStart, spans[k + 1] ?? 0)

				// Characters are already checked: only references need decoding to be validated.
				if (hasReference(bytes, valueStart, valueEnd)) decodeCharacterData(bytes, valueStart, valueEnd, true)

				if (name.prefix === "" || name.prefix === "xmlns") continue

				const uri = namespaces.uri(node, name.prefix)

				if (uri === undefined) throw new XmlError("unboundPrefix", `Prefix ${name.prefix} is not declared`, nameStart)

				if (hashed) {
					const key = `${uri}\u0000${name.local}`

					if (expanded.has(key)) throw new XmlError("invalidAttribute", "Duplicate attribute by namespace", nameStart)

					expanded.add(key)

					continue
				}

				for (let other = 0; other < uris.length; other++) {
					if (uris[other] === uri && locals[other] === name.local) {
						throw new XmlError("invalidAttribute", "Duplicate attribute by namespace", nameStart)
					}
				}

				uris.push(uri)
				locals.push(name.local)

				if (uris.length > PAIRWISE_DUPLICATE_LIMIT) {
					hashed = true

					for (let other = 0; other < uris.length; other++) expanded.add(`${uris[other] ?? ""}\u0000${locals[other] ?? ""}`)
				}
			}
		} else if (kind === NodeKind.Text) {
			let reference = false

			for (let at = start; at < end; at++) {
				const b = bytes[at]

				if (b === 38) reference = true
				if (b === 93 && bytes[at + 1] === 93 && bytes[at + 2] === 62 && at + 2 < end) {
					throw new XmlError("invalidContent", '"]]>" in text', at)
				}
			}

			if (reference) decodeCharacterData(bytes, start, end, false)
		} else if (kind === NodeKind.Comment) {
			// Content is [start + 4, end - 3): it may hold no "--" and may not end with "-".
			for (let at = start + 4; at < end - 3; at++) {
				if (bytes[at] === 45 && (bytes[at + 1] === 45 || at === end - 4))
					throw new XmlError("invalidContent", '"--" in a comment', at)
			}
		}
	}
}
