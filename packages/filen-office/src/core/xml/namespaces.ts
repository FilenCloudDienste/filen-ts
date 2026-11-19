import { NodeKind, type XmlDocument } from "./document"
import { sliceClock, type Slicing } from "../slicing"
import { decodeCharacterData } from "./entities"
import { XmlError } from "./errors"
import { decodeUtf8 } from "./utf8"

export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace"
export const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/"

const NO_BINDINGS: ReadonlyMap<string, string> = new Map()

// In-scope bindings copied across all declaring elements, past which a part is refused: each copy holds its
// parent's whole scope, so nested or repeated new prefixes would otherwise grow memory quadratically.
const SCOPE_ENTRY_BUDGET = 4_000_000

// Elements whose start tag contains "xmlns" among the hits in bytes [from, to), added to `found`: found by a
// native scan of the part for the byte sequence, each hit mapped to its node by binary search over the
// (ascending) node starts. A tag holds no child, so the last node starting at or before a hit inside a start
// tag is that element.
function declaringElements(document: XmlDocument, found: number[], from: number, to: number): void {
	const { bytes, kinds, starts, openEnds, count } = document
	// Hits are looked for in the range only, so a part without one is scanned once however it is cut.
	const range = to === bytes.length ? bytes : bytes.subarray(0, to)

	for (let at = range.indexOf(120, from); at >= 0; at = range.indexOf(120, at + 1)) {
		if (bytes[at + 1] !== 109 || bytes[at + 2] !== 108 || bytes[at + 3] !== 110 || bytes[at + 4] !== 115) continue

		let low = 0
		let high = count - 1

		while (low < high) {
			const middle = (low + high + 1) >> 1

			if ((starts[middle] ?? 0) <= at) {
				low = middle
			} else {
				high = middle - 1
			}
		}

		if (kinds[low] === NodeKind.Element && at < (openEnds[low] ?? 0) && found[found.length - 1] !== low) found.push(low)
	}
}

// Bytes scanned for declarations between two looks at the clock.
const SLICE_BYTES = 1024 * 1024

function declarations(document: XmlDocument, node: number): Map<string, string> | null {
	const spans = document.attributeSpans(node)
	let bindings: Map<string, string> | null = null

	for (let k = 0; k < spans.length; k += 4) {
		const name = decodeUtf8(document.bytes, spans[k] ?? 0, spans[k + 1] ?? 0)

		if (name !== "xmlns" && !name.startsWith("xmlns:")) continue

		bindings ??= new Map()
		bindings.set(name === "xmlns" ? "" : name.slice(6), decodeCharacterData(document.bytes, spans[k + 2] ?? 0, spans[k + 3] ?? 0, true))
	}

	return bindings
}

// Prefix resolution by in-scope xmlns declarations: generators pick their own prefixes ("ns0:"), and Strict
// OOXML binds the usual ones to different URIs, so names are only ever compared as (URI, local name).
// Each declaring element gets its complete in-scope map once. When declarations sit only on the root (the
// usual case) every lookup uses that one map; otherwise each node's nearest declaring element is recorded
// in one pass, so no lookup walks an ancestor chain. An element whose own bindings are all in scope already
// with the same URI shares its parent's map.
export class Namespaces {
	readonly document: XmlDocument
	// Declaring element -> its own bindings (prefix, "" for the default namespace -> URI, "" undeclares).
	private readonly own = new Map<number, Map<string, string>>()
	// Declaring element -> every binding in scope there.
	private readonly scopes = new Map<number, ReadonlyMap<string, string>>()
	// Nearest declaring element at or above each node (-1 for none); null when only the root declares.
	private readonly scopeOf: Int32Array | null
	private readonly rootScope: ReadonlyMap<string, string>
	private readonly uriByNameId: (string | null | undefined)[] = []

	// Declaring elements whose start tag could not be read (lenient mode only); their declarations are ignored.
	readonly malformed: number[] = []

	// `lenient`: a declaring element with a malformed start tag (duplicate or unquoted attributes, a bad
	// reference) is recorded in `malformed` instead of throwing, for readers that degrade such content.
	// `declaring`: the elements whose start tag contains "xmlns", ascending, when already found.
	constructor(document: XmlDocument, options: { readonly lenient?: boolean } = {}, declaring?: readonly number[]) {
		this.document = document

		if (declaring === undefined) {
			const found: number[] = []

			declaringElements(document, found, 0, document.bytes.length)
			declaring = found
		}

		const root = document.documentElement()
		// Declaring elements with bindings, ascending.
		const declared: number[] = []
		let flat = true

		for (const node of declaring) {
			let bindings: Map<string, string> | null = null

			try {
				bindings = declarations(document, node)
			} catch (error) {
				if (options.lenient !== true) throw error

				this.malformed.push(node)
			}

			if (bindings === null) continue

			this.own.set(node, bindings)
			declared.push(node)

			if (node !== root) flat = false
		}

		if (flat) {
			this.scopeOf = null
			this.rootScope = this.own.get(root) ?? NO_BINDINGS

			return
		}

		// Parents precede children in node order, so one forward pass settles every node, and each declaring
		// element's map extends its parent's scope, which is already built.
		const { parents, count } = document
		const scopeOf = new Int32Array(count)
		let next = 0
		let nextNode = declared[0] ?? count
		let copied = 0

		scopeOf[0] = -1

		for (let node = 1; node < count; node++) {
			const inherited = scopeOf[parents[node] ?? 0] ?? -1

			if (node !== nextNode) {
				scopeOf[node] = inherited

				continue
			}

			const parentScope = inherited < 0 ? NO_BINDINGS : (this.scopes.get(inherited) ?? NO_BINDINGS)
			const own = this.own.get(node) ?? NO_BINDINGS
			let redundant = true

			for (const [prefix, uri] of own) {
				if (parentScope.get(prefix) !== uri) {
					redundant = false

					break
				}
			}

			nextNode = declared[++next] ?? count

			if (redundant) {
				scopeOf[node] = inherited

				continue
			}

			const scope = new Map(parentScope)

			for (const [prefix, uri] of own) scope.set(prefix, uri)

			copied += scope.size

			if (copied > SCOPE_ENTRY_BUDGET) {
				throw new XmlError("invalidContent", "Too many namespace bindings in scope", document.start(node))
			}

			this.scopes.set(node, scope)
			scopeOf[node] = node
		}

		this.scopeOf = scopeOf
		this.rootScope = NO_BINDINGS
	}

	// The same as the constructor, with the part scanned for declarations a range at a time and the host
	// given a turn whenever the slice is used up.
	static async sliced(document: XmlDocument, options: { readonly lenient?: boolean }, slicing: Slicing): Promise<Namespaces> {
		const clock = sliceClock(slicing)
		const length = document.bytes.length
		const found: number[] = []

		for (let from = 0; from < length; from += SLICE_BYTES) {
			declaringElements(document, found, from, Math.min(length, from + SLICE_BYTES))

			if (clock.due) await clock.pause()
		}

		return new Namespaces(document, options, found)
	}

	// Every declaring element's own bindings, in document order.
	declarations(): ReadonlyMap<number, ReadonlyMap<string, string>> {
		return this.own
	}

	// All bindings in scope at `node`.
	inScope(node: number): ReadonlyMap<string, string> {
		if (this.scopeOf === null) return this.rootScope

		const scope = this.scopeOf[node] ?? -1

		return scope < 0 ? NO_BINDINGS : (this.scopes.get(scope) ?? NO_BINDINGS)
	}

	// URI bound to `prefix` ("" = default namespace) in scope at `node`, or undefined when unbound.
	uri(node: number, prefix: string): string | undefined {
		if (prefix === "xml") return XML_NAMESPACE
		if (prefix === "xmlns") return XMLNS_NAMESPACE

		const uri = this.inScope(node).get(prefix)

		return uri === "" ? undefined : uri
	}

	// Namespace URI of an element.
	elementUri(node: number): string | undefined {
		if (this.scopeOf !== null) return this.uri(node, this.document.prefix(node))

		const id = this.document.nameId(node)
		let uri = this.uriByNameId[id]

		if (uri === undefined) {
			uri = this.uri(node, this.document.prefix(node)) ?? null
			this.uriByNameId[id] = uri
		}

		return uri ?? undefined
	}

	// Whether an element is {uri}localName.
	is(node: number, uri: string, localName: string): boolean {
		return (
			this.document.kinds[node] === NodeKind.Element && this.document.localName(node) === localName && this.elementUri(node) === uri
		)
	}

	// Value of the attribute {uri}localName (uri "" = unprefixed, which carries no namespace).
	attribute(node: number, uri: string, localName: string): string | undefined {
		if (uri === "") return this.document.attribute(node, localName)

		for (const attribute of this.document.attributes(node)) {
			const colon = attribute.name.indexOf(":")

			if (colon > 0 && attribute.name.slice(colon + 1) === localName && this.uri(node, attribute.name.slice(0, colon)) === uri) {
				return attribute.value
			}
		}

		return undefined
	}

	// The prefix the document itself uses for `uri` at `node`, so new markup matches what is there; "" for
	// the default namespace, undefined when `uri` is not in scope.
	prefixFor(node: number, uri: string): string | undefined {
		for (const [prefix, bound] of this.inScope(node)) {
			if (bound === uri && bound !== "") return prefix
		}

		return undefined
	}
}
