import { describe, expect, it } from "vitest"
import { mathText } from "../core/docx/pdf/math"
import { ommlToMathTree } from "../core/math/index"
import { encodeUtf8, parseXml } from "../core/xml/index"

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"

function text(body: string): string {
	const document = parseXml(encodeUtf8(`<root xmlns:m="${M}"><m:oMath>${body}</m:oMath></root>`))
	let node = 0

	while (node < document.count && document.localName(node) !== "oMath") node++

	const tree = ommlToMathTree(document, node)

	if (tree === undefined) throw new Error("No math")

	return mathText(tree)
}

const r = (value: string): string => `<m:r><m:t>${value}</m:t></m:r>`

describe("mathText", () => {
	it("keeps the degree of an nth root", () => {
		expect(text(`<m:rad><m:deg>${r("3")}</m:deg><m:e>${r("x")}</m:e></m:rad>`)).toBe("√(3&x)")
	})

	it("writes a root with a hidden degree as a square root", () => {
		expect(text(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg>${r("3")}</m:deg><m:e>${r("x")}</m:e></m:rad>`)).toBe("√(x)")
	})

	it("separates the limits of an n-ary operator drawn above and below", () => {
		const nary = (limits: string): string =>
			`<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>${limits}<m:e>${r("i")}</m:e></m:nary>`

		expect(text(nary(`<m:sub>${r("i=1")}</m:sub><m:sup>${r("n")}</m:sup>`))).toBe("∑_(i=1)^(n)i")
		expect(text(nary(`<m:sub>${r("i=1")}</m:sub>`))).toBe("∑_(i=1)i")
		expect(text(nary(`<m:sup>${r("n")}</m:sup>`))).toBe("∑^(n)i")
	})

	it("leaves accents, bars and group characters as plain text", () => {
		expect(text(`<m:acc><m:accPr><m:chr m:val="̃"/></m:accPr><m:e>${r("x")}</m:e></m:acc>`)).toBe("x~")
		expect(text(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${r("x")}</m:e></m:bar>`)).toBe("x‾")
		expect(text(`<m:groupChr><m:e>${r("x")}</m:e></m:groupChr>`)).toBe("x⏟")
	})
})
