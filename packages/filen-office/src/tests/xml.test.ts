import { describe, expect, it } from "vitest"
import {
	MC_NAMESPACE,
	Namespaces,
	NodeKind,
	XML_NAMESPACE,
	XmlError,
	assertWellFormed,
	decodeUtf8,
	escapeAttribute,
	escapeText,
	parseXml,
	selectAlternateContent,
	type XmlDocument
} from "@filen/office/core/xml"
import { budget } from "./timing"

const encoder = new TextEncoder()

function parse(source: string): XmlDocument {
	return parseXml(encoder.encode(source))
}

function rawText(document: XmlDocument, node: number): string {
	return decodeUtf8(document.raw(node))
}

function codeOf(run: () => unknown): string | undefined {
	try {
		run()
	} catch (error) {
		return error instanceof XmlError ? error.code : `not an XmlError: ${String(error)}`
	}

	return undefined
}

describe("parseXml structure", () => {
	it("records every node kind with its byte span", () => {
		const document = parse('<?xml version="1.0"?><!-- c --><r a="1"><b>x</b><![CDATA[<y>]]><?pi data?><e/></r>')
		const kinds: NodeKind[] = []

		for (let node = 0; node < document.count; node++) kinds.push(document.kind(node))

		expect(kinds).toEqual([
			NodeKind.Document,
			NodeKind.ProcessingInstruction,
			NodeKind.Comment,
			NodeKind.Element,
			NodeKind.Element,
			NodeKind.Text,
			NodeKind.CData,
			NodeKind.ProcessingInstruction,
			NodeKind.Element
		])

		const root = document.documentElement()

		expect(document.name(root)).toBe("r")
		expect(rawText(document, root)).toBe('<r a="1"><b>x</b><![CDATA[<y>]]><?pi data?><e/></r>')
		expect(rawText(document, 4)).toBe("<b>x</b>")
		expect(document.openEnd(4) - document.start(4)).toBe(3)
		expect(document.text(6)).toBe("<y>")
		expect(document.text(7)).toBe("data")
		expect(document.name(7)).toBe("pi")
		expect(document.text(2)).toBe(" c ")
		expect(document.isSelfClosing(8)).toBe(true)
		expect(document.textContent(root)).toBe("x<y>")
	})

	it("links parents, children and siblings", () => {
		const document = parse("<r><a/><b><c/></b>t<d/></r>")
		const root = document.documentElement()
		const names: string[] = []

		for (let child = document.firstChild(root); child >= 0; child = document.nextSibling(child)) {
			names.push(document.kind(child) === NodeKind.Text ? `#${document.text(child)}` : document.name(child))
		}

		expect(names).toEqual(["a", "b", "#t", "d"])

		const b = document.firstChildElement(root, document.nameIdOf("b"))
		const c = document.firstChildElement(b)

		expect(document.name(c)).toBe("c")
		expect(document.parent(c)).toBe(b)
		expect(document.nextSiblingElement(b)).toBe(document.firstChildElement(root, document.nameIdOf("d")))
		expect(document.nameIdOf("missing")).toBe(-1)
	})

	it("gives the content span of elements", () => {
		const document = parse("<r><p>abc</p><q/><s></s ></r>")
		const p = document.firstChildElement(document.documentElement())
		const q = document.nextSiblingElement(p)
		const s = document.nextSiblingElement(q)

		expect(decodeUtf8(document.bytes, document.contentStart(p), document.contentEnd(p))).toBe("abc")
		expect(document.contentStart(q)).toBe(document.contentEnd(q))
		expect(document.contentStart(s)).toBe(document.contentEnd(s))
		expect(rawText(document, s)).toBe("<s></s >")
	})

	it("keeps multi-byte UTF-8 names and text, and a byte order mark", () => {
		const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("<wörter ä='ü'>日本 😀</wörter>")])
		const document = parseXml(bytes)
		const root = document.documentElement()

		expect(document.name(root)).toBe("wörter")
		expect(document.attribute(root, "ä")).toBe("ü")
		expect(document.textContent(root)).toBe("日本 😀")
		expect(document.start(0)).toBe(0)
		expect(document.end(0)).toBe(bytes.length)
	})

	it("decodes invalid UTF-8 to replacement characters", () => {
		expect(decodeUtf8(Uint8Array.from([0x61, 0xff, 0x62, 0xc3]))).toBe("a�b�")
		expect(decodeUtf8(Uint8Array.from([0xe0, 0x80, 0x80]))).toBe("���")
		expect(decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toBe("���")
	})

	it("decodes long ASCII and multi-byte runs", () => {
		const long = "a".repeat(20_000) + "é".repeat(10_000)

		expect(decodeUtf8(encoder.encode(long))).toBe(long)
		expect(decodeUtf8(encoder.encode("b".repeat(20_000)))).toBe("b".repeat(20_000))
	})

	it("stores a node in 29 bytes", () => {
		const document = parse(`<r>${"<p><r><t>text</t></r></p>".repeat(2000)}</r>`)
		const arrays = [
			document.kinds,
			document.starts,
			document.openEnds,
			document.ends,
			document.parents,
			document.firstChildren,
			document.nextSiblings,
			document.nameIds
		]
		const bytes = arrays.reduce((sum, array) => sum + array.byteLength, 0)

		expect(bytes / document.count).toBeLessThanOrEqual(29 * 1.125)
		expect(arrays.every(array => array.length >= document.count)).toBe(true)
	})
})

describe("parseXml attributes", () => {
	it("reads both quote styles, spacing around = and references", () => {
		const document = parse('<r a="1" b=\'two\' c = "&lt;&amp;&#65;&#x1F600;" d=\'say "hi"\' e="it\'s"/>')
		const root = document.documentElement()

		expect(document.attributes(root)).toEqual([
			{ name: "a", value: "1" },
			{ name: "b", value: "two" },
			{ name: "c", value: "<&A😀" },
			{ name: "d", value: 'say "hi"' },
			{ name: "e", value: "it's" }
		])
		expect(document.attribute(root, "c")).toBe("<&A😀")
		expect(document.attribute(root, "z")).toBeUndefined()
	})

	it("normalises whitespace in attribute values but keeps references", () => {
		const document = parse('<r a="x\ty\r\nz" b="1&#10;2&#9;3"/>')
		const root = document.documentElement()

		expect(document.attribute(root, "a")).toBe("x y z")
		expect(document.attribute(root, "b")).toBe("1\n2\t3")
	})

	it("returns spans that slice the raw value", () => {
		const document = parse("<r x=\"a&amp;b\" y='c'/>")
		const spans = document.attributeSpans(document.documentElement())

		expect(Array.from(spans).length).toBe(8)
		expect(decodeUtf8(document.bytes, spans[2], spans[3])).toBe("a&amp;b")
		expect(decodeUtf8(document.bytes, spans[6], spans[7])).toBe("c")
	})

	it("reports malformed attributes when they are read", () => {
		const cases = ['<r a="1" a="2"/>', "<r a=1/>", '<r a="1"b="2"/>', "<r a/>", '<r ="1"/>', "<r a='1/>", '<r a="<"/>']

		for (const source of cases) {
			expect(
				codeOf(() => {
					const document = parse(source)

					document.attributes(document.documentElement())
				}),
				source
			).toMatch(/invalidAttribute|unterminated/)
		}
	})
})

describe("parseXml text", () => {
	it("resolves the predefined entities and character references", () => {
		const document = parse("<r>&lt;&gt;&amp;&quot;&apos; &#38; &#x26; &#128512;</r>")

		expect(document.textContent(document.documentElement())).toBe("<>&\"' & & 😀")
	})

	it("normalises line ends in text and CDATA", () => {
		const document = parse("<r>a\r\nb\rc<![CDATA[d\r\ne]]></r>")

		expect(document.textContent(document.documentElement())).toBe("a\nb\ncd\ne")
	})

	it("treats CDATA content literally", () => {
		const document = parse("<r><![CDATA[&amp; <not a tag> ]] ]]></r>")

		expect(document.textContent(document.documentElement())).toBe("&amp; <not a tag> ]] ")
	})

	it("rejects undefined entities and invalid references", () => {
		for (const reference of ["&nbsp;", "&#0;", "&#xD800;", "&#x110000;", "&#;", "&#xZ;", "&amp"]) {
			expect(
				codeOf(() => {
					const document = parse(`<r>${reference}</r>`)

					document.textContent(document.documentElement())
				}),
				reference
			).toBe("invalidReference")
		}
	})

	it("escapes text and attribute values for new markup", () => {
		expect(escapeText("a<b>&c\r")).toBe("a&lt;b&gt;&amp;c&#13;")
		expect(escapeText("plain")).toBe("plain")
		expect(escapeAttribute("\"x\"\t'y'\n&<")).toBe("&quot;x&quot;&#9;&apos;y&apos;&#10;&amp;&lt;")

		const document = parse(`<r a="${escapeAttribute("a\tb\nc \"'&<")}">${escapeText("x\r\ny")}</r>`)

		expect(document.attribute(document.documentElement(), "a")).toBe("a\tb\nc \"'&<")
		expect(document.textContent(document.documentElement())).toBe("x\r\ny")
	})
})

describe("parseXml errors", () => {
	const cases: [string, string][] = [
		['<!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>', "doctype"],
		["<r><a></b></r>", "mismatchedTag"],
		["<r><a></r>", "mismatchedTag"],
		["<r><a>", "unclosedElement"],
		["</r>", "unexpectedCloseTag"],
		["<r/></r>", "unexpectedCloseTag"],
		["text<r/>", "contentOutsideRoot"],
		["<r/>text", "contentOutsideRoot"],
		["<r/><s/>", "contentOutsideRoot"],
		["<![CDATA[x]]><r/>", "contentOutsideRoot"],
		["<!-- only a comment -->", "contentOutsideRoot"],
		["", "contentOutsideRoot"],
		["<r><!-- open", "unterminated"],
		["<r><![CDATA[open", "unterminated"],
		["<r><?pi open", "unterminated"],
		["<r a='1'", "unterminated"],
		["<r a='1", "unterminated"],
		["<r></r", "unterminated"],
		["<r", "unterminated"],
		["<r <a/>", "invalidAttribute"],
		["<r/><?xml version='1.0'?>", "invalidName"],
		["<r><!ELEMENT x></r>", "invalidName"],
		["<r>< a/></r>", "invalidName"],
		["<r><? x?></r>", "invalidName"]
	]

	it.each(cases)("%s -> %s", (source, code) => {
		expect(codeOf(() => parse(source))).toBe(code)
	})

	it("refuses encodings it cannot read", () => {
		expect(codeOf(() => parseXml(Uint8Array.from([0x3c, 0x00, 0x72])))).toBe("encoding")
		expect(codeOf(() => parseXml(Uint8Array.from([0x00, 0x00, 0x00, 0x3c])))).toBe("encoding")
	})

	it("reports the byte offset", () => {
		expect(() => parse("<r><a></b></r>")).toThrow(expect.objectContaining({ code: "mismatchedTag", offset: 6 }))
	})

	it("checks attributes and references in assertWellFormed", () => {
		expect(() => assertWellFormed(parse('<r a="1"><b c="&amp;">&lt;</b></r>'))).not.toThrow()
		expect(codeOf(() => assertWellFormed(parse('<r><b c="&bad;"/></r>')))).toBe("invalidReference")
		expect(codeOf(() => assertWellFormed(parse("<r><b>&bad;</b></r>")))).toBe("invalidReference")
		expect(codeOf(() => assertWellFormed(parse("<r><b c=x/></r>")))).toBe("invalidAttribute")
	})
})

describe("Namespaces", () => {
	const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
	const STRICT_W = "http://purl.oclc.org/ooxml/wordprocessingml/main"

	it("resolves prefixes declared on the root", () => {
		const document = parse(
			`<ns0:document xmlns:ns0="${W}" xmlns="urn:default"><ns0:body><plain xml:space="preserve"/></ns0:body></ns0:document>`
		)
		const namespaces = new Namespaces(document)
		const root = document.documentElement()
		const body = document.firstChildElement(root)
		const plain = document.firstChildElement(body)

		expect(namespaces.is(root, W, "document")).toBe(true)
		expect(namespaces.is(body, W, "body")).toBe(true)
		expect(namespaces.is(body, STRICT_W, "body")).toBe(false)
		expect(namespaces.elementUri(plain)).toBe("urn:default")
		expect(namespaces.attribute(plain, XML_NAMESPACE, "space")).toBe("preserve")
		expect(namespaces.prefixFor(plain, W)).toBe("ns0")
		expect(namespaces.prefixFor(plain, "urn:default")).toBe("")
		expect(namespaces.prefixFor(plain, "urn:absent")).toBeUndefined()
	})

	it("honours nested declarations, shadowing and undeclaring", () => {
		const document = parse('<a:r xmlns:a="urn:1" xmlns="urn:d"><a:x xmlns:a="urn:2"><a:y/><z xmlns=""/></a:x><a:w/></a:r>')
		const namespaces = new Namespaces(document)
		const root = document.documentElement()
		const x = document.firstChildElement(root)
		const y = document.firstChildElement(x)
		const z = document.nextSiblingElement(y)
		const w = document.nextSiblingElement(x)

		expect(namespaces.elementUri(root)).toBe("urn:1")
		expect(namespaces.elementUri(x)).toBe("urn:2")
		expect(namespaces.elementUri(y)).toBe("urn:2")
		expect(namespaces.elementUri(z)).toBeUndefined()
		expect(namespaces.elementUri(w)).toBe("urn:1")
		expect(namespaces.prefixFor(y, "urn:1")).toBeUndefined()
		expect(namespaces.prefixFor(w, "urn:1")).toBe("a")
	})

	it("reads namespaced attributes by URI", () => {
		const document = parse(`<w:p xmlns:w="${W}" xmlns:x="${W}" w:val="1" x:other="2" val="3"/>`)
		const namespaces = new Namespaces(document)
		const root = document.documentElement()

		expect(namespaces.attribute(root, W, "val")).toBe("1")
		expect(namespaces.attribute(root, W, "other")).toBe("2")
		expect(namespaces.attribute(root, "", "val")).toBe("3")
	})
})

describe("selectAlternateContent", () => {
	const source = (requires: string): string =>
		`<r xmlns:mc="${MC_NAMESPACE}" xmlns:wps="urn:wps" xmlns:v="urn:vml"><mc:AlternateContent>` +
		`<mc:Choice Requires="${requires}"><wps:shape/></mc:Choice><mc:Fallback><v:shape/></mc:Fallback></mc:AlternateContent></r>`

	function pick(requires: string, understood: string[]): string {
		const document = parse(source(requires))
		const namespaces = new Namespaces(document)
		const alternate = document.firstChildElement(document.documentElement())
		const chosen = selectAlternateContent(namespaces, alternate, uri => understood.includes(uri))

		return chosen < 0 ? "" : document.localName(chosen)
	}

	it("takes the first understood choice", () => {
		expect(pick("wps", ["urn:wps"])).toBe("Choice")
	})

	it("falls back when a required namespace is not understood or not declared", () => {
		expect(pick("wps", [])).toBe("Fallback")
		expect(pick("wps undeclared", ["urn:wps"])).toBe("Fallback")
		expect(pick("", ["urn:wps"])).toBe("Fallback")
	})

	it("ignores elements that are not mc:AlternateContent", () => {
		const document = parse("<r><x/></r>")
		const namespaces = new Namespaces(document)

		expect(selectAlternateContent(namespaces, document.documentElement(), () => true)).toBe(-1)
	})
})

describe("parseXml encodings and document types", () => {
	function utf16(source: string, littleEndian: boolean, bom: boolean): Uint8Array {
		const out = new Uint8Array((source.length + (bom ? 1 : 0)) * 2)
		const units = (bom ? "﻿" : "") + source

		for (let k = 0; k < units.length; k++) {
			const code = units.charCodeAt(k)

			out[k * 2 + (littleEndian ? 0 : 1)] = code & 0xff
			out[k * 2 + (littleEndian ? 1 : 0)] = code >> 8
		}

		return out
	}

	it.each([
		[true, true],
		[true, false],
		[false, true],
		[false, false]
	])("transcodes UTF-16 (little endian %s, byte order mark %s)", (littleEndian, bom) => {
		const document = parseXml(utf16('<?xml version="1.0" encoding="UTF-16"?><r a="é">日本 😀</r>', littleEndian, bom))

		expect(document.encoding).toBe(littleEndian ? "utf-16le" : "utf-16be")
		expect(document.textContent(document.documentElement())).toBe("日本 😀")
		expect(document.attribute(document.documentElement(), "a")).toBe("é")
		expect(decodeUtf8(document.bytes).startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true)
	})

	it("keeps an external document type as an opaque node and refuses internal subsets", () => {
		const document = parse(
			'<?xml version="1.0"?><!DOCTYPE manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd"><r/>'
		)

		expect(document.kind(2)).toBe(NodeKind.DocumentType)
		expect(document.text(2)).toBe('manifest:manifest PUBLIC "-//OpenOffice.org//DTD Manifest 1.0//EN" "Manifest.dtd"')
		expect(codeOf(() => parse('<!DOCTYPE r SYSTEM "a[1].dtd"><r/>'))).toBeUndefined()
		expect(codeOf(() => parse("<!DOCTYPE r [ ]><r/>"))).toBe("doctype")
		expect(codeOf(() => parse("<r/><!DOCTYPE r>"))).toBe("doctype")
		expect(codeOf(() => parse("<!DOCTYPE r><!DOCTYPE r><r/>"))).toBe("doctype")
		expect(codeOf(() => parse("<!DOCTYPE r <r/>"))).toBe("doctype")
	})
})

describe("assertWellFormed", () => {
	it.each([
		["<a><!-- a -- b --></a>", "invalidContent"],
		["<a><!-- a ---></a>", "invalidContent"],
		["<1a/>", "invalidName"],
		["<a:b:c xmlns:a='u'/>", "invalidName"],
		["<a 1x='1'/>", "invalidName"],
		["<a>]]></a>", "invalidContent"],
		["<a\u0001/>", "invalidCharacter"],
		["<a>x\u000by</a>", "invalidCharacter"],
		["<a>￾</a>", "invalidCharacter"],
		["<a xmlns:p=''/>", "unboundPrefix"],
		["<p:a/>", "unboundPrefix"],
		["<a p:x='1'/>", "unboundPrefix"],
		["<a xmlns:xml='urn:x'/>", "unboundPrefix"],
		["<a xmlns:xmlns='urn:x'/>", "unboundPrefix"],
		["<a xmlns:p='http://www.w3.org/XML/1998/namespace'/>", "unboundPrefix"],
		["<a xmlns:p='u' xmlns:q='u' p:x='1' q:x='2'/>", "invalidAttribute"],
		["<xmlns:a/>", "unboundPrefix"]
	])("refuses %j (%s)", (source, code) => {
		expect(codeOf(() => assertWellFormed(parse(source)))).toBe(code)
	})

	it("refuses invalid UTF-8 and encoded surrogates", () => {
		for (const bytes of [
			[0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e],
			[0x3c, 0x61, 0x3e, 0xed, 0xa0, 0x80, 0x3c, 0x2f, 0x61, 0x3e],
			[0x3c, 0x61, 0x3e, 0xc0, 0xaf, 0x3c, 0x2f, 0x61, 0x3e]
		]) {
			expect(codeOf(() => assertWellFormed(parseXml(Uint8Array.from(bytes))))).toBe("invalidCharacter")
		}
	})

	it("accepts namespaced, nested and reserved-prefix markup", () => {
		const source =
			'<w:d xmlns:w="u1" xmlns="u0" xml:lang="en"><x:e xmlns:x="u2" x:a="1" w:a="2" a="3"><f xmlns=""/></x:e>' +
			"<!-- fine - comment --><![CDATA[]] >]]><?pi x?>&#x1F600;é</w:d>"

		expect(() => assertWellFormed(parse(source))).not.toThrow()
	})
})

describe("escaping for new markup", () => {
	it("replaces characters XML cannot carry and keeps valid pairs", () => {
		expect(escapeText("a\u0001b\u000bc￾￿d\ud800e\udc00f😀\t\n")).toBe("a�b�c��d�e�f😀\t\n")
		expect(escapeAttribute("\u0000\ud83d")).toBe("��")

		const document = parse(`<r a="${escapeAttribute("x\u0002y")}">${escapeText("\u001f&")}</r>`)

		expect(() => assertWellFormed(document)).not.toThrow()
	})
})

describe("attribute lookup", () => {
	it("finds one attribute's value span without parsing the others", () => {
		const document = parse('<r a="1" bb=\'x&amp;y\' c = "3"/>')
		const span = new Int32Array(2)

		expect(document.findAttribute(1, "bb", span)).toBe(true)
		expect(decodeUtf8(document.bytes, span[0], span[1])).toBe("x&amp;y")
		expect(document.findAttribute(1, "c", span)).toBe(true)
		expect(decodeUtf8(document.bytes, span[0], span[1])).toBe("3")
		expect(document.findAttribute(1, "b", span)).toBe(false)
		expect(document.attribute(1, "bb")).toBe("x&y")
	})

	it("detects duplicates among many attributes", () => {
		const many = Array.from({ length: 50 }, (_, k) => ` a${k}="v"`).join("")

		expect(() => parse(`<r${many}/>`).attributeSpans(1)).not.toThrow()
		expect(codeOf(() => parse(`<r${many} a7="w"/>`).attributeSpans(1))).toBe("invalidAttribute")
	})
})

describe("linear time on hostile shapes", () => {
	const time = (run: () => void): number => {
		const started = performance.now()

		run()

		return performance.now() - started
	}

	it("handles a 3 MB worksheet", () => {
		let body = ""

		for (let row = 1; row <= 16_000; row++) {
			body += `<row r="${row}">`

			for (let column = 0; column < 5; column++) body += `<c r="${"ABCDE"[column]}${row}" t="s"><v>${row * 5 + column}</v></c>`

			body += "</row>"
		}

		const bytes = encoder.encode(
			`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
		)

		// Quadratic scans took minutes here; linear work takes well under a second.
		expect(
			time(() => {
				const document = parseXml(bytes)

				new Namespaces(document)
				assertWellFormed(document)
			})
		).toBeLessThan(budget(5000))
	})

	it("handles a deep chain of nested namespace declarations", () => {
		const depth = 100_000
		const bytes = encoder.encode(`${'<a xmlns:p="u">'.repeat(depth)}<p:b/>${"</a>".repeat(depth)}`)

		expect(
			time(() => {
				const document = parseXml(bytes)
				const namespaces = new Namespaces(document)

				for (let node = 1; node < document.count; node++) namespaces.elementUri(node)

				expect(namespaces.elementUri(document.count - 1)).toBe("u")
				assertWellFormed(document)
			})
		).toBeLessThan(budget(5000))
	})

	it("handles an element with 40,000 attributes", () => {
		const bytes = encoder.encode(`<r xmlns="u"${Array.from({ length: 40_000 }, (_, k) => ` a${k}="v"`).join("")}/>`)

		expect(
			time(() => {
				const document = parseXml(bytes)

				document.attributeSpans(1)
				new Namespaces(document)
				assertWellFormed(document)

				for (let k = 0; k < 100; k++) document.attribute(1, "a39999")
			})
		).toBeLessThan(budget(5000))
	})

	it("checks 100,000 prefixed attributes for namespace duplicates in linear time", () => {
		const bytes = encoder.encode(`<r xmlns:p="u"${Array.from({ length: 100_000 }, (_, k) => ` p:a${k}="v"`).join("")}/>`)

		// A pairwise expanded-name scan took over ten seconds here.
		expect(
			time(() => {
				assertWellFormed(parseXml(bytes))
			})
		).toBeLessThan(budget(2000))
	})

	it("detects a namespace duplicate past the pairwise limit", () => {
		const many = Array.from({ length: 20 }, (_, k) => ` p:a${k}="v"`).join("")

		expect(() => assertWellFormed(parse(`<r xmlns:p="u" xmlns:q="u"${many} q:a20="w"/>`))).not.toThrow()
		expect(codeOf(() => assertWellFormed(parse(`<r xmlns:p="u" xmlns:q="u"${many} q:a7="w"/>`)))).toBe("invalidAttribute")
	})
})
