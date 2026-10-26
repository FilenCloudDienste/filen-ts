import { NodeKind, Namespaces, encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"

// XML compared by meaning, for proof gate 1 (an unedited element written by the emitters against its source) and
// for the history's fingerprints of source subtrees. What does not change meaning is ignored: attribute order, the
// empty-element form, the prefixes chosen (names compare as namespace URI and local name), namespace declarations,
// comments and processing instructions, and whitespace-only text between elements. Text inside an element with no
// element children is kept exactly (a:t " " is a space), and mc:Ignorable / ProcessContent / MustUnderstand
// compare by the namespaces their prefixes name.

const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const MC_PREFIX_LISTS: ReadonlySet<string> = new Set(["Ignorable", "MustUnderstand"])

const namespaces = new WeakMap<XmlDocument, Namespaces>()

function namespacesOf(document: XmlDocument): Namespaces {
	let held = namespaces.get(document)

	if (held === undefined) {
		held = new Namespaces(document, { lenient: true })
		namespaces.set(document, held)
	}

	return held
}

function isWhitespace(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return false
	}

	return true
}

function hasElementChild(document: XmlDocument, node: number): boolean {
	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		if (document.kind(child) === NodeKind.Element) return true
	}

	return false
}

function qualified(ns: Namespaces, node: number, name: string): string {
	const colon = name.indexOf(":")

	if (colon < 0) return name

	return `{${ns.uri(node, name.slice(0, colon)) ?? name.slice(0, colon)}}${name.slice(colon + 1)}`
}

function prefixList(ns: Namespaces, node: number, value: string): string {
	return value
		.split(/\s+/u)
		.filter(token => token !== "")
		.map(token => ns.uri(node, token) ?? token)
		.sort()
		.join(" ")
}

function attributesOf(document: XmlDocument, ns: Namespaces, node: number): string {
	const out: string[] = []

	for (const attribute of document.attributes(node)) {
		const name = attribute.name

		if (name === "xmlns" || name.startsWith("xmlns:")) continue

		const key = qualified(ns, node, name)
		const local = name.slice(name.indexOf(":") + 1)
		const value = key.startsWith(`{${MC}}`) && MC_PREFIX_LISTS.has(local) ? prefixList(ns, node, attribute.value) : attribute.value

		out.push(`${key}=${JSON.stringify(value)}`)
	}

	return out.sort().join(" ")
}

function write(document: XmlDocument, ns: Namespaces, node: number, out: string[]): void {
	const elementUri = ns.elementUri(node) ?? ""

	out.push(`<{${elementUri}}${document.localName(node)}`)

	const attributes = attributesOf(document, ns, node)

	if (attributes !== "") out.push(" ", attributes)

	out.push(">")

	const mixed = hasElementChild(document, node)
	let text = ""

	for (let child = document.firstChild(node); child >= 0; child = document.nextSibling(child)) {
		switch (document.kind(child)) {
			case NodeKind.Element:
				if (text !== "") {
					if (!isWhitespace(text)) out.push(JSON.stringify(text))
					text = ""
				}

				write(document, ns, child, out)
				break
			case NodeKind.Text:
			case NodeKind.CData:
				text += document.text(child)
				break
			default:
				break
		}
	}

	if (text !== "" && (!mixed || !isWhitespace(text))) out.push(JSON.stringify(text))

	out.push("</>")
}

// The canonical form of an element and its subtree.
export function canonicalXml(document: XmlDocument, node: number): string {
	const out: string[] = []

	write(document, namespacesOf(document), node, out)

	return out.join("")
}

export function sameXmlMeaning(a: XmlDocument, aNode: number, b: XmlDocument, bNode: number): boolean {
	return canonicalXml(a, aNode) === canonicalXml(b, bNode)
}

// The namespace declarations in scope at `node` that its own start tag does not make: what a copy of the element
// needs to be read on its own.
export function inheritedDeclarations(document: XmlDocument, node: number): ReadonlyMap<string, string> {
	const ns = namespacesOf(document)
	const parent = document.parent(node)

	return parent <= 0 ? ns.inScope(document.documentElement()) : ns.inScope(parent)
}

const WRAPPER = "canonical-scope"

// Markup (one element, as bytes) parsed in the namespace scope `scope` (prefix → URI): the document and the element.
// Throws XmlError on markup that is not well formed.
export function parseInScope(
	markup: Uint8Array,
	scope: ReadonlyMap<string, string>
): { readonly document: XmlDocument; readonly node: number } {
	let open = `<${WRAPPER}`

	for (const [prefix, uri] of scope) {
		if (uri === "") continue

		open += prefix === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${prefix}="${escapeAttribute(uri)}"`
	}

	const head = encodeUtf8(`${open}>`)
	const tail = encodeUtf8(`</${WRAPPER}>`)
	const bytes = new Uint8Array(head.length + markup.length + tail.length)

	bytes.set(head, 0)
	bytes.set(markup, head.length)
	bytes.set(tail, head.length + markup.length)

	const document = parseXml(bytes)
	const root = document.documentElement()

	return { document, node: document.firstChildElement(root) }
}
