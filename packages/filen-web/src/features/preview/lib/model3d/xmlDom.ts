import { Namespaces, NodeKind, encodeUtf8, parseXml, type XmlDocument } from "@filen/office/core/xml"

// The DOMParser ThreeMFLoader reads a 3MF's model and relationships with, which a worker has none of: @filen/office's
// parser behind the few DOM members that loader uses (documentElement, querySelector/All with type and descendant
// selectors, getElementsByTagNameNS, getAttribute/NS, attributes, children, nodeName, textContent). Type selectors match local names, as CSS does
// in an XML document whatever the prefix. Nothing here resolves entities beyond XML's own or loads anything.

// One parsed document, its namespaces resolved on first use.
class Source {
	readonly doc: XmlDocument
	#namespaces: Namespaces | null = null

	constructor(doc: XmlDocument) {
		this.doc = doc
	}

	get namespaces(): Namespaces {
		this.#namespaces ??= new Namespaces(this.doc)

		return this.#namespaces
	}
}

export class XmlElement {
	readonly #source: Source
	readonly #doc: XmlDocument
	readonly #node: number

	constructor(source: Source, node: number) {
		this.#source = source
		this.#doc = source.doc
		this.#node = node
	}

	get nodeName(): string {
		return this.#doc.name(this.#node)
	}

	get localName(): string {
		return this.#doc.localName(this.#node)
	}

	get textContent(): string {
		return this.#doc.textContent(this.#node)
	}

	get attributes(): readonly { readonly name: string; readonly value: string }[] {
		return this.#doc.attributes(this.#node)
	}

	get children(): XmlElement[] {
		const children: XmlElement[] = []

		for (let child = this.#doc.firstChildElement(this.#node); child >= 0; child = this.#doc.nextSiblingElement(child)) {
			children.push(new XmlElement(this.#source, child))
		}

		return children
	}

	getAttribute(name: string): string | null {
		return this.#doc.attribute(this.#node, name) ?? null
	}

	getAttributeNS(uri: string, localName: string): string | null {
		return this.#source.namespaces.attribute(this.#node, uri, localName) ?? null
	}

	querySelector(selector: string): XmlElement | null {
		return select(this.#source, this.#node, selector, true)[0] ?? null
	}

	querySelectorAll(selector: string): XmlElement[] {
		return select(this.#source, this.#node, selector, false)
	}

	getElementsByTagNameNS(uri: string, localName: string): XmlElement[] {
		const namespaces = this.#source.namespaces

		return descendants(this.#source, this.#node, node => namespaces.is(node, uri, localName), false)
	}
}

// Elements below `root` that `matches` takes, in document order: nodes are numbered in document order, a subtree's
// contiguously after its root.
function descendants(source: Source, root: number, matches: (node: number) => boolean, first: boolean): XmlElement[] {
	const { doc } = source
	const end = doc.end(root)
	const found: XmlElement[] = []

	for (let node = root + 1; node < doc.count && doc.start(node) < end; node++) {
		if (doc.kinds[node] !== NodeKind.Element || !matches(node)) continue

		found.push(new XmlElement(source, node))

		if (first) break
	}

	return found
}

// Elements below `root` matching a descendant chain of type selectors ("vertices vertex").
function select(source: Source, root: number, selector: string, first: boolean): XmlElement[] {
	const { doc } = source
	const chain = selector.trim().split(/\s+/)
	const last = chain.at(-1)

	if (last === undefined || chain.some(part => !/^[\w-]+$/.test(part))) throw new SyntaxError(`unsupported selector "${selector}"`)

	const matches = (node: number): boolean => {
		if (doc.localName(node) !== last) return false

		// The rest of the chain, right to left, among the ancestors up to (not including) the root.
		let at = chain.length - 2

		for (let up = doc.parent(node); at >= 0 && up !== root && up > 0; up = doc.parent(up)) {
			if (doc.localName(up) === chain[at]) at--
		}

		return at < 0
	}

	return descendants(source, root, matches, first)
}

export class XmlDomDocument extends XmlElement {
	readonly documentElement: XmlElement

	constructor(doc: XmlDocument) {
		const source = new Source(doc)

		super(source, 0)

		this.documentElement = new XmlElement(source, doc.documentElement())
	}
}

export class XmlDomParser {
	parseFromString(text: string, _type: string): XmlDomDocument {
		return new XmlDomDocument(parseXml(encodeUtf8(text)))
	}
}
