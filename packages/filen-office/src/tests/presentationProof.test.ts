import { describe, expect, it } from "vitest"
import { canonicalXml, inheritedDeclarations, parseInScope, sameXmlMeaning } from "../core/presentation/edit/canonical"
import { xfrmProves } from "../core/presentation/edit/proof"
import { encodeUtf8, parseXml } from "../core/xml/index"

const A = "http://schemas.openxmlformats.org/drawingml/2006/main"
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"

function root(xml: string): { document: ReturnType<typeof parseXml>; node: number } {
	const document = parseXml(encodeUtf8(xml))

	return { document, node: document.documentElement() }
}

function same(a: string, b: string): boolean {
	const x = root(a)
	const y = root(b)

	return sameXmlMeaning(x.document, x.node, y.document, y.node)
}

describe("XML meaning", () => {
	it("ignores attribute order, the empty-element form, prefixes, declarations and whitespace between elements", () => {
		expect(same(`<a:off xmlns:a="${A}" x="1" y="2"/>`, `<d:off y="2" x="1" xmlns:d="${A}"></d:off>`)).toBe(true)
		expect(same(`<a:p xmlns:a="${A}"><a:r/>\n  <a:r/></a:p>`, `<a:p xmlns:a="${A}"><a:r/><a:r/></a:p>`)).toBe(true)
		expect(same(`<a:p xmlns:a="${A}"><!-- note --><a:r/></a:p>`, `<a:p xmlns:a="${A}"><a:r/></a:p>`)).toBe(true)
	})

	it("keeps the text of an element without children exactly, and attribute values as written", () => {
		expect(same(`<a:t xmlns:a="${A}"> </a:t>`, `<a:t xmlns:a="${A}"/>`)).toBe(false)
		expect(same(`<a:t xmlns:a="${A}">a&amp;b</a:t>`, `<a:t xmlns:a="${A}"><![CDATA[a&b]]></a:t>`)).toBe(true)
		expect(same(`<a:off xmlns:a="${A}" x="1"/>`, `<a:off xmlns:a="${A}" x="01"/>`)).toBe(false)
		expect(same(`<a:off xmlns:a="${A}" x="1"/>`, '<a:off xmlns:a="urn:other" x="1"/>')).toBe(false)
	})

	it("compares mc:Ignorable by the namespaces its prefixes name", () => {
		expect(
			same(
				`<r xmlns:mc="${MC}" xmlns:p14="urn:p14" xmlns:a14="urn:a14" mc:Ignorable="p14 a14"/>`,
				`<r xmlns:mc="${MC}" xmlns:x="urn:p14" xmlns:y="urn:a14" mc:Ignorable="y x"/>`
			)
		).toBe(true)
	})

	it("reads a copied element inside the scope it came from", () => {
		const { document, node } = root(`<root xmlns:a="${A}"><a:p><a:r><a:t>x</a:t></a:r></a:p></root>`)
		const element = document.firstChildElement(node)
		const scope = inheritedDeclarations(document, element)
		const copy = parseInScope(document.raw(element), scope)

		expect(canonicalXml(copy.document, copy.node)).toBe(canonicalXml(document, element))
	})
})

describe("proof of a shape's box", () => {
	const P = "http://schemas.openxmlformats.org/presentationml/2006/main"

	it("proves an a:xfrm of off and ext only, or none at all", () => {
		const plain = root(
			`<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr></p:sp>`
		)
		const none = root(`<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:spPr/></p:sp>`)
		const extra = root(
			`<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/><a:extLst/></a:xfrm></p:spPr></p:sp>`
		)

		expect(xfrmProves(plain.document, plain.node)).toBe(true)
		expect(xfrmProves(none.document, none.node)).toBe(true)
		expect(xfrmProves(extra.document, extra.node)).toBe(false)
	})
})
