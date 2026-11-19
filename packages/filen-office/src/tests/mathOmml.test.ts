import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	MathFrame,
	MathTreeError,
	assertMathTree,
	ommlParagraphToMathTrees,
	ommlToMathTree,
	styleText,
	MathStyle,
	tokenize,
	type MathElement,
	type MathNode
} from "../core/math/index"
import { encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
const M_STRICT = "http://purl.oclc.org/ooxml/officeDocument/math"
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

function parse(body: string, mathUri: string = M, prefix: string = "m"): XmlDocument {
	return parseXml(encodeUtf8(`<root xmlns:${prefix}="${mathUri}" xmlns:w="${W}">${body}</root>`))
}

function firstMath(document: XmlDocument): number {
	for (let node = 0; node < document.count; node++) {
		const local = document.localName(node)

		if (local === "oMath" || local === "oMathPara") return node
	}

	return -1
}

// Converts `<m:oMath>body</m:oMath>` and validates the result.
function math(body: string): MathElement {
	const document = parse(`<m:oMath>${body}</m:oMath>`)
	const tree = ommlToMathTree(document, firstMath(document))

	if (tree === undefined) throw new Error("No math")

	assertMathTree(tree)

	return tree
}

// A compact rendering for assertions: tag(children), token text in quotes, selected attributes.
function show(node: MathNode): string {
	if (typeof node === "string") return JSON.stringify(node)

	const attributes =
		node.attributes === undefined ? "" : `[${Object.entries(node.attributes).map(([key, value]) => `${key}=${String(value)}`)}]`

	if (node.tag === "mi" || node.tag === "mn" || node.tag === "mo" || node.tag === "mtext") {
		return `${node.tag}${attributes}${JSON.stringify(node.children[0])}`
	}

	return `${node.tag}${attributes}(${node.children.map(show).join(" ")})`
}

function run(text: string, properties: string = ""): string {
	return `<m:r>${properties === "" ? "" : `<m:rPr>${properties}</m:rPr>`}<m:t xml:space="preserve">${text}</m:t></m:r>`
}

describe("runs", () => {
	it("splits text into identifiers, numbers and operators", () => {
		expect(show(math(run("x+12.5=ab")))).toBe('math(mi"x" mo"+" mn"12.5" mo"=" mi"a" mi"b")')
	})

	it("keeps spaces as mspace and attaches combining marks", () => {
		expect(show(math(run("a b x̂")))).toBe('math(mi"a" mspace[width=0.222]() mi"b" mspace[width=0.222]() mi"x̂")')
	})

	it("maps m:sty and m:scr to mathematical alphanumerics", () => {
		expect(show(math(run("x", '<m:sty m:val="p"/>')))).toBe('math(mi[mathvariant=normal]"x")')
		expect(show(math(run("Ab1", '<m:sty m:val="b"/>')))).toBe('math(mi"𝐀" mi"𝐛" mn"𝟏")')
		expect(show(math(run("BeR", '<m:scr m:val="script"/>')))).toBe('math(mi"ℬ" mi"ℯ" mi"ℛ")')
		expect(show(math(run("RZx", '<m:scr m:val="double-struck"/>')))).toBe('math(mi"ℝ" mi"ℤ" mi"𝕩")')
		expect(show(math(run("H", '<m:scr m:val="fraktur"/>')))).toBe('math(mi"ℌ")')
		expect(show(math(run("H", '<m:scr m:val="fraktur"/><m:sty m:val="b"/>')))).toBe('math(mi"𝕳")')
		expect(show(math(run("a", '<m:scr m:val="sans-serif"/><m:sty m:val="p"/>')))).toBe('math(mi"𝖺")')
		expect(show(math(run("a", '<m:scr m:val="monospace"/>')))).toBe('math(mi"𝚊")')
	})

	it("styles Greek and leaves letters without a styled form alone", () => {
		expect(styleText("αΩ∇", MathStyle.BOLD)).toBe("𝛂𝛀𝛁")
		expect(styleText("h", MathStyle.ITALIC)).toBe("ℎ")
		expect(styleText("α", MathStyle.SCRIPT)).toBe("α")
	})

	it("reads m:nor runs as text and m:lit runs without operators", () => {
		expect(show(math(run(" if x ", "<m:nor/>")))).toBe('math(mtext" if x ")')
		expect(show(math(run("a+b", "<m:lit/>")))).toBe('math(mi"a" mi"+" mi"b")')
	})

	it("turns only edge spaces of m:nor text into no-break spaces, in linear time", () => {
		const nbsp = "\u00a0"

		expect(show(math(run("  x  ", "<m:nor/>")))).toBe(`math(mtext"${nbsp}${nbsp}x${nbsp}${nbsp}")`)
		expect(show(math(run("   ", "<m:nor/>")))).toBe(`math(mtext"${nbsp.repeat(3)}")`)
		expect(show(math(run("a  b", "<m:nor/>")))).toBe('math(mtext"a  b")')

		const inner = " ".repeat(300_000)
		const started = performance.now()
		const tree = math(run(`a${inner}b`, "<m:nor/>"))

		expect(performance.now() - started).toBeLessThan(1000)
		expect(show(tree)).toBe(`math(mtext"a${inner}b")`)
	})

	it("carries w:color and ignores m:ctrlPr", () => {
		const tree = math('<m:r><w:rPr><w:color w:val="ff0000"/></w:rPr><m:t>x</m:t></m:r><m:ctrlPr><w:rPr><w:i/></w:rPr></m:ctrlPr>')

		expect(show(tree)).toBe('math(mi[color=FF0000]"x")')
	})

	it("reads tracked insertions and drops deletions", () => {
		expect(show(math(`<w:ins>${run("a")}</w:ins><w:del>${run("b")}</w:del>`))).toBe('math(mi"a")')
	})

	it("groups function names into upright identifiers", () => {
		expect(tokenize("sin", { groupLetters: true }).map(token => token.text)).toEqual(["sin"])
		expect(show(math(`<m:func><m:fName>${run("sin", '<m:sty m:val="p"/>')}</m:fName><m:e>${run("x")}</m:e></m:func>`))).toBe(
			'math(mrow(mi"sin" mo"⁡" mi"x"))'
		)
	})

	it("keeps a limit base whole inside a function name", () => {
		const tree = math(
			`<m:func><m:fName><m:limLow><m:e>${run("lim")}</m:e><m:lim>${run("n→∞")}</m:lim></m:limLow></m:fName><m:e>${run("a")}</m:e></m:func>`
		)

		expect(show(tree)).toBe('math(mrow(munder(mi"lim" mrow(mi"n" mo"→" mi"∞")) mo"⁡" mi"a"))')
	})
})

describe("objects", () => {
	it("converts fractions of every type", () => {
		const fraction = (type: string): string =>
			show(
				math(
					`<m:f>${type === "" ? "" : `<m:fPr><m:type m:val="${type}"/></m:fPr>`}<m:num>${run("1")}</m:num><m:den>${run("2")}</m:den></m:f>`
				)
			)

		expect(fraction("")).toBe('math(mfrac(mn"1" mn"2"))')
		expect(fraction("noBar")).toBe('math(mfrac[linethickness=0](mn"1" mn"2"))')
		expect(fraction("lin")).toBe('math(mrow(mn"1" mo"/" mn"2"))')
		expect(fraction("skw")).toBe('math(mrow(msup(mrow() mn"1") mo[stretchy=false]"/" msub(mrow() mn"2")))')
	})

	it("converts scripts and prescripts", () => {
		expect(show(math(`<m:sSup><m:e>${run("x")}</m:e><m:sup>${run("2")}</m:sup></m:sSup>`))).toBe('math(msup(mi"x" mn"2"))')
		expect(show(math(`<m:sSub><m:e>${run("x")}</m:e><m:sub>${run("i")}</m:sub></m:sSub>`))).toBe('math(msub(mi"x" mi"i"))')
		expect(show(math(`<m:sSubSup><m:e>${run("x")}</m:e><m:sub>${run("i")}</m:sub><m:sup>${run("2")}</m:sup></m:sSubSup>`))).toBe(
			'math(msubsup(mi"x" mi"i" mn"2"))'
		)
		expect(show(math(`<m:sPre><m:sub>${run("1")}</m:sub><m:sup>${run("2")}</m:sup><m:e>${run("X")}</m:e></m:sPre>`))).toBe(
			'math(mmultiscripts(mi"X" mprescripts() mn"1" mn"2"))'
		)
	})

	it("converts radicals with and without a degree", () => {
		expect(show(math(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${run("x+1")}</m:e></m:rad>`))).toBe(
			'math(msqrt(mi"x" mo"+" mn"1"))'
		)
		expect(show(math(`<m:rad><m:deg>${run("3")}</m:deg><m:e>${run("x")}</m:e></m:rad>`))).toBe('math(mroot(mi"x" mn"3"))')
		expect(show(math(`<m:rad><m:deg/><m:e>${run("x")}</m:e></m:rad>`))).toBe('math(msqrt(mi"x"))')
	})

	it("converts n-ary operators with limit locations and hidden limits", () => {
		const integral = math(`<m:nary><m:sub>${run("0")}</m:sub><m:sup>${run("1")}</m:sup><m:e>${run("f")}</m:e></m:nary>`)

		expect(show(integral)).toBe('math(mrow(msubsup(mo[largeop=true]"∫" mn"0" mn"1") mi"f"))')

		const sum = math(
			`<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${run("i=1")}</m:sub><m:sup>${run("n")}</m:sup><m:e>${run("i")}</m:e></m:nary>`
		)

		expect(show(sum)).toBe('math(mrow(munderover(mo[largeop=true]"∑" mrow(mi"i" mo"=" mn"1") mi"n") mi"i"))')

		const hidden = math(
			`<m:nary><m:naryPr><m:chr m:val="∏"/><m:limLoc m:val="subSup"/><m:supHide m:val="1"/><m:grow m:val="1"/></m:naryPr><m:sub>${run("k")}</m:sub><m:sup/><m:e>${run("a")}</m:e></m:nary>`
		)

		expect(show(hidden)).toBe('math(mrow(msub(mo[largeop=true,stretchy=true]"∏" mi"k") mi"a"))')
	})

	it("honours the document's limit defaults", () => {
		const document = parse(
			`<m:oMath><m:nary><m:sub>${run("0")}</m:sub><m:sup>${run("1")}</m:sup><m:e>${run("f")}</m:e></m:nary></m:oMath>`
		)
		const tree = ommlToMathTree(document, firstMath(document), { integralLimits: "undOvr" })

		expect(tree && show(tree)).toBe('math(mrow(munderover(mo[largeop=true]"∫" mn"0" mn"1") mi"f"))')
	})

	it("converts delimiters with separators and empty characters", () => {
		expect(show(math(`<m:d><m:e>${run("x")}</m:e></m:d>`))).toBe(
			'math(mrow(mo[form=prefix,fence=true,stretchy=true]"(" mi"x" mo[form=postfix,fence=true,stretchy=true]")"))'
		)

		const set = math(
			`<m:d><m:dPr><m:begChr m:val="{"/><m:sepChr m:val=","/><m:endChr m:val=""/><m:grow m:val="0"/></m:dPr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:d>`
		)

		expect(show(set)).toBe(
			'math(mrow(mo[form=prefix,fence=true,stretchy=false]"{" mi"a" mo[form=infix,separator=true,stretchy=false]"," mi"b"))'
		)
	})

	it("converts matrices with column alignment", () => {
		const tree = math(
			`<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="left"/></m:mcPr></m:mc><m:mc><m:mcPr><m:count m:val="1"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr><m:mr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:mr><m:mr><m:e/><m:e>${run("d")}</m:e></m:mr></m:m>`
		)

		expect(show(tree)).toBe('math(mtable(mtr(mtd[columnalign=left](mi"a") mtd(mi"b")) mtr(mtd[columnalign=left]() mtd(mi"d"))))')
	})

	it("aligns equation arrays at their & points", () => {
		const tree = math(`<m:eqArr><m:e>${run("x&amp;=1")}</m:e><m:e>${run("yy&amp;=2")}</m:e></m:eqArr>`)

		expect(show(tree)).toBe(
			'math(mtable(mtr(mtd[columnalign=right](mi"x") mtd[columnalign=left](mo"=" mn"1")) mtr(mtd[columnalign=right](mi"y" mi"y") mtd[columnalign=left](mo"=" mn"2"))))'
		)
		expect(show(math(`<m:eqArr><m:e>${run("a")}</m:e><m:e>${run("b")}</m:e></m:eqArr>`))).toBe(
			'math(mtable(mtr(mtd(mi"a")) mtr(mtd(mi"b"))))'
		)
	})

	it("drops & outside aligning rows", () => {
		expect(show(math(`<m:f><m:num>${run("a&amp;b")}</m:num><m:den>${run("c")}</m:den></m:f>`))).toBe(
			'math(mfrac(mrow(mi"a" mi"b") mi"c"))'
		)
	})

	it("converts accents, bars and group characters", () => {
		expect(show(math(`<m:acc><m:e>${run("x")}</m:e></m:acc>`))).toBe('math(mover[accent=true](mi"x" mo"^"))')
		expect(show(math(`<m:acc><m:accPr><m:chr m:val="⃗"/></m:accPr><m:e>${run("v")}</m:e></m:acc>`))).toBe(
			'math(mover[accent=true](mi"v" mo"→"))'
		)
		expect(show(math(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${run("z")}</m:e></m:bar>`))).toBe(
			'math(mover[accent=true](mi"z" mo[stretchy=true]"‾"))'
		)
		expect(show(math(`<m:bar><m:e>${run("z")}</m:e></m:bar>`))).toBe('math(munder[accentunder=true](mi"z" mo[stretchy=true]"_"))')
		expect(show(math(`<m:groupChr><m:e>${run("ab")}</m:e></m:groupChr>`))).toBe('math(munder(mrow(mi"a" mi"b") mo[stretchy=true]"⏟"))')
		expect(
			show(math(`<m:groupChr><m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/></m:groupChrPr><m:e>${run("a")}</m:e></m:groupChr>`))
		).toBe('math(mover(mi"a" mo[stretchy=true]"⏞"))')
	})

	it("converts boxes with frame hints", () => {
		expect(show(math(`<m:box><m:e>${run("a")}</m:e></m:box>`))).toBe('math(mi"a")')
		expect(show(math(`<m:borderBox><m:e>${run("a")}</m:e></m:borderBox>`))).toBe('math(mrow[frame=15](mi"a"))')

		const struck = math(
			`<m:borderBox><m:borderBoxPr><m:hideTop/><m:hideBot/><m:hideLeft/><m:hideRight/><m:strikeBLTR/></m:borderBoxPr><m:e>${run("a")}</m:e></m:borderBox>`
		)

		expect(struck.children[0]).toMatchObject({ tag: "mrow", attributes: { frame: MathFrame.STRIKE_UP } })
	})

	it("converts limits", () => {
		expect(show(math(`<m:limUpp><m:e>${run("x")}</m:e><m:lim>${run("n")}</m:lim></m:limUpp>`))).toBe('math(mover(mi"x" mi"n"))')
	})

	it("converts phantoms", () => {
		expect(show(math(`<m:phant><m:phantPr><m:show m:val="0"/></m:phantPr><m:e>${run("x")}</m:e></m:phant>`))).toBe(
			'math(mphantom(mi"x"))'
		)
		expect(show(math(`<m:phant><m:phantPr><m:show m:val="0"/><m:zeroWid/></m:phantPr><m:e>${run("x")}</m:e></m:phant>`))).toBe(
			'math(mpadded[width=0](mphantom(mi"x")))'
		)
		expect(show(math(`<m:phant><m:phantPr><m:zeroAsc/><m:zeroDesc/></m:phantPr><m:e>${run("x")}</m:e></m:phant>`))).toBe(
			'math(mpadded[height=0,depth=0](mi"x"))'
		)
	})

	it("applies argument size as a script level change", () => {
		expect(show(math(`<m:f><m:num><m:argPr><m:argSz m:val="-1"/></m:argPr>${run("a")}</m:num><m:den>${run("b")}</m:den></m:f>`))).toBe(
			'math(mfrac(mstyle[scriptlevel=1](mi"a") mi"b"))'
		)
	})
})

describe("equations and paragraphs", () => {
	it("breaks lines at w:br into a left-aligned table", () => {
		expect(show(math(`${run("a")}<m:r><w:br/><m:t>b</m:t></m:r>`))).toBe(
			'math(mtable(mtr(mtd[columnalign=left](mi"a")) mtr(mtd[columnalign=left](mi"b"))))'
		)
	})

	it("converts display paragraphs with their alignment", () => {
		const document = parse(
			`<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${run("a")}</m:oMath><m:oMath>${run("b")}</m:oMath></m:oMathPara>`
		)
		const node = firstMath(document)
		const tree = ommlToMathTree(document, node)

		expect(tree && show(tree)).toBe(
			'math[display=block,align=left](mtable(mtr(mtd[columnalign=left](mi"a")) mtr(mtd[columnalign=left](mi"b"))))'
		)
		expect(ommlParagraphToMathTrees(document, node).map(show)).toEqual([
			'math[display=block,align=left](mi"a")',
			'math[display=block,align=left](mi"b")'
		])
	})

	it("matches Strict namespaces and other prefixes", () => {
		const document = parse(
			"<o:oMath><o:sSup><o:e><o:r><o:t>x</o:t></o:r></o:e><o:sup><o:r><o:t>2</o:t></o:r></o:sup></o:sSup></o:oMath>",
			M_STRICT,
			"o"
		)
		const tree = ommlToMathTree(document, firstMath(document))

		expect(tree && show(tree)).toBe('math(msup(mi"x" mn"2"))')
	})

	it("returns undefined for empty equations and other elements", () => {
		const document = parse("<m:oMath><m:r><m:t/></m:r></m:oMath><m:r/>")

		expect(ommlToMathTree(document, firstMath(document))).toBeUndefined()
		expect(ommlToMathTree(document, 0)).toBeUndefined()
	})

	it("survives deep nesting and unknown elements", () => {
		let body = run("x")

		for (let k = 0; k < 400; k++) body = `<m:f><m:num>${body}</m:num><m:den>${run("2")}</m:den></m:f>`

		const tree = math(`<m:unknown>${run("u")}</m:unknown>${body}`)

		expect(tree.children[0]).toMatchObject({ tag: "mi", children: ["u"] })
	})

	it("reads malformed attributes as absent", () => {
		const document = parse(`<m:oMath><m:d><m:dPr><m:begChr m:val="&bogus;"/></m:dPr><m:e>${run("x")}</m:e></m:d></m:oMath>`)
		const tree = ommlToMathTree(document, firstMath(document))

		expect(tree).toBeDefined()
		assertMathTree(tree)
	})
})

describe("hostile OMML", () => {
	it("reads an unknown m:limLoc as the default", () => {
		const tree = math(
			'<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="sideways"/></m:naryPr><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>n</m:t></m:r></m:sup><m:e><m:r><m:t>x</m:t></m:r></m:e></m:nary>'
		)

		expect(show(tree)).toContain("munderover")
	})
})

describe("assertMathTree", () => {
	it("rejects tags, attributes and text outside the allowlist", () => {
		const bad: unknown[] = [
			{ tag: "script", children: [] },
			{ tag: "mi", children: [] },
			{ tag: "mrow", children: ["text"] },
			{ tag: "mi", attributes: { style: "color:red" }, children: ["x"] },
			{ tag: "mi", attributes: { color: "red" }, children: ["x"] },
			{ tag: "mspace", attributes: { width: 1e9 }, children: [] },
			{ tag: "mfrac", children: [{ tag: "mi", children: ["x"] }] },
			{
				tag: "mmultiscripts",
				children: [
					{ tag: "mi", children: ["x"] },
					{ tag: "mi", children: ["y"] }
				]
			}
		]

		for (const node of bad) expect(() => assertMathTree(node)).toThrow(MathTreeError)
	})

	it("rejects trees deeper than the limit", () => {
		let node: MathElement = { tag: "mi", children: ["x"] }

		for (let k = 0; k < 1100; k++) node = { tag: "mrow", children: [node] }

		expect(() => assertMathTree(node)).toThrow(MathTreeError)
	})
})

describe("math sources", () => {
	it("write no-break, invisible and combining characters as escapes", () => {
		const directory = join(import.meta.dirname, "..", "core", "math")

		for (const file of ["latex.ts", "omml.ts", "ommlTrack.ts", "toLatex.ts"]) {
			expect(readFileSync(join(directory, file), "utf8"), file).not.toMatch(
				/[\u00a0\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff\p{Mn}]/u
			)
		}
	})
})
