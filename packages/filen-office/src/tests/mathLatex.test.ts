import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { MAX_OMML_NESTING, latexPreview, latexToOmml, ommlToLatex, readLatex, writeOmml, type OmmlNode } from "@filen/office/core/docx/edit"
import { assertMathTree, ommlToMathTree } from "@filen/office/core/math"
import { OpcPackage, bytesSource } from "@filen/office/core/opc"
import { Namespaces, NodeKind, encodeUtf8, parseXml, type XmlDocument } from "@filen/office/core/xml"
import { OMML_ELEMENTS } from "../core/docx/write/checks/math"
import { CORPUS_DIR as CORPUS } from "./corpusDir"
import { equationRunProperties } from "../core/docx/math/edit"
import { diffTrees, firstRunProperties, ommlStringTree, ommlTree, treeXml, withRunProperties } from "../core/math/ommlTrack"
import { rng } from "./fuzz/config"
import { budget, cpuMs } from "./timing"

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math"

function parsed(omml: string): { document: XmlDocument; node: number } {
	const document = parseXml(encodeUtf8(`<root xmlns:m="${M}">${omml}</root>`))

	return { document, node: document.firstChildElement(document.documentElement()) }
}

// XML as the editor keeps it (m: and w: undeclared) parsed.
function parsedTracked(omml: string): { document: XmlDocument; node: number } {
	const document = parseXml(
		encodeUtf8(`<root xmlns:m="${M}" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${omml}</root>`)
	)

	return { document, node: document.firstChildElement(document.documentElement()) }
}

function omml(latex: string, display = false): string {
	const written = latexToOmml(latex, display)

	if (!written.ok) throw new Error(`${latex}: ${JSON.stringify(written.error)}`)

	return written.omml
}

// The LaTeX an equation written from `latex` reads back as.
function back(latex: string, display = false): { latex: string; lossy: boolean } {
	const { document, node } = parsed(omml(latex, display))

	return ommlToLatex(document, node)
}

const R = (text: string): string => `<m:r><m:t>${text}</m:t></m:r>`

describe("LaTeX subset to OMML", () => {
	it("writes each construct as Word writes it", () => {
		expect(omml("\\frac{a}{b}")).toBe(`<m:oMath><m:f><m:num>${R("a")}</m:num><m:den>${R("b")}</m:den></m:f></m:oMath>`)
		expect(omml("\\sqrt{x}")).toBe(
			`<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${R("x")}</m:e></m:rad></m:oMath>`
		)
		expect(omml("\\sqrt[n]{x}")).toBe(`<m:oMath><m:rad><m:deg>${R("n")}</m:deg><m:e>${R("x")}</m:e></m:rad></m:oMath>`)
		expect(omml("x_i^2")).toBe(
			`<m:oMath><m:sSubSup><m:e>${R("x")}</m:e><m:sub>${R("i")}</m:sub><m:sup>${R("2")}</m:sup></m:sSubSup></m:oMath>`
		)
		expect(omml("\\sum\\limits_{k}x")).toBe(
			`<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/><m:supHide m:val="1"/></m:naryPr><m:sub>${R("k")}</m:sub><m:sup/><m:e>${R("x")}</m:e></m:nary></m:oMath>`
		)
		expect(omml("\\left[ a \\middle| b \\right.")).toBe(
			`<m:oMath><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val=""/></m:dPr><m:e>${R("a")}</m:e><m:e>${R("b")}</m:e></m:d></m:oMath>`
		)
		expect(omml("\\begin{bmatrix}1 & 2\\\\3\\end{bmatrix}")).toBe(
			'<m:oMath><m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val="2"/><m:mcJc m:val="center"/></m:mcPr></m:mc></m:mcs></m:mPr>' +
				`<m:mr><m:e>${R("1")}</m:e><m:e>${R("2")}</m:e></m:mr><m:mr><m:e>${R("3")}</m:e><m:e/></m:mr></m:m></m:e></m:d></m:oMath>`
		)
		expect(omml("\\begin{cases}1 & x\\\\0\\end{cases}")).toBe(
			`<m:oMath><m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val=""/></m:dPr><m:e><m:eqArr><m:e>${R("1&amp;x")}</m:e><m:e>${R("0")}</m:e></m:eqArr></m:e></m:d></m:oMath>`
		)
		expect(omml("\\vec{v}\\overline{z}\\underbrace{ab}_{2}")).toBe(
			`<m:oMath><m:acc><m:accPr><m:chr m:val="\u20d7"/></m:accPr><m:e>${R("v")}</m:e></m:acc><m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${R("z")}</m:e></m:bar>` +
				`<m:limLow><m:e><m:groupChr><m:groupChrPr><m:chr m:val="⏟"/></m:groupChrPr><m:e>${R("ab")}</m:e></m:groupChr></m:e><m:lim>${R("2")}</m:lim></m:limLow></m:oMath>`
		)
		expect(omml("\\lim_{n\\to\\infty} a_n")).toBe(
			`<m:oMath><m:func><m:fName><m:limLow><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>lim</m:t></m:r></m:e><m:lim>${R("n→∞")}</m:lim></m:limLow></m:fName>` +
				`<m:e><m:sSub><m:e>${R("a")}</m:e><m:sub>${R("n")}</m:sub></m:sSub></m:e></m:func></m:oMath>`
		)
		expect(omml("\\mathbf{v}\\mathbb{R}\\text{ if } \\alpha")).toBe(
			'<m:oMath><m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>v</m:t></m:r><m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>R</m:t></m:r>' +
				`<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve"> if </m:t></m:r>${R("α")}</m:oMath>`
		)
		expect(omml("a\\,b\\quad c<d\\&")).toBe(`<m:oMath>${R("a\u2009b\u2003c&lt;d&amp;")}</m:oMath>`)
	})

	it("reads LaTeX's own conventions: one token per argument, math delimiters, comments, sizes", () => {
		expect(omml("x^10")).toBe(`<m:oMath><m:sSup><m:e>${R("x")}</m:e><m:sup>${R("1")}</m:sup></m:sSup>${R("0")}</m:oMath>`)
		expect(omml("\\frac12")).toBe(omml("\\frac{1}{2}"))
		expect(omml("$x$")).toBe(omml("x"))
		expect(omml("\\[x\\]")).toBe(omml("x"))
		expect(omml("x % a comment\n+y")).toBe(omml("x+y"))
		expect(omml("\\bigl( x \\bigr)")).toBe(omml("(x)"))
		expect(omml("f'")).toBe(`<m:oMath><m:sSup><m:e>${R("f")}</m:e><m:sup>${R("′")}</m:sup></m:sSup></m:oMath>`)
		expect(omml("\\binom{n}{k}")).toContain('<m:type m:val="noBar"/>')
	})

	it("puts the lines of a display equation in equations of their own", () => {
		expect(omml("a \\\\ b", true)).toBe(`<m:oMathPara><m:oMath>${R("a")}</m:oMath><m:oMath>${R("b")}</m:oMath></m:oMathPara>`)
		expect(latexToOmml("a \\\\ b", false)).toEqual({ ok: false, error: { code: "unexpected", offset: 2, token: "\\\\" } })
	})

	it("says where and why it cannot read", () => {
		const error = (latex: string): unknown => {
			const read = readLatex(latex)

			return read.ok ? undefined : read.error
		}

		expect(error("   ")).toEqual({ code: "empty", offset: 3 })
		expect(error("{}")).toEqual({ code: "empty", offset: 0 })
		expect(error("x".repeat(10_001))).toEqual({ code: "tooLong", offset: 10_000 })
		expect(error("a+\\foo")).toEqual({ code: "unknownCommand", offset: 2, token: "\\foo" })
		expect(error("\\begin{align}x\\end{align}")).toEqual({ code: "unknownCommand", offset: 0, token: "align" })
		expect(error("\\frac{a}")).toEqual({ code: "missingArgument", offset: 0, token: "\\frac" })
		expect(error("x^")).toEqual({ code: "missingArgument", offset: 1, token: "^" })
		expect(error("\\lim\\below")).toEqual({ code: "missingArgument", offset: 4, token: "\\below" })
		expect(error("{a")).toEqual({ code: "unbalanced", offset: 0, token: "{" })
		expect(error("a}")).toEqual({ code: "unbalanced", offset: 1, token: "}" })
		expect(error("\\left( a")).toEqual({ code: "unbalanced", offset: 0, token: "\\left" })
		expect(error("a \\right)")).toEqual({ code: "unbalanced", offset: 2, token: "\\right" })
		expect(error("\\begin{matrix}a\\end{pmatrix}")).toEqual({ code: "unbalanced", offset: 15, token: "\\end" })
		expect(error("x^2^3")).toEqual({ code: "unexpected", offset: 3, token: "^" })
		expect(error("a & b")).toEqual({ code: "unexpected", offset: 2, token: "&" })
		expect(error("a\u0001")).toEqual({ code: "unexpected", offset: 1, token: "\u0001" })
		expect(error("\\left( a \\middle| b \\middle/ c \\right)")).toEqual({ code: "unexpected", offset: 20, token: "\\middle" })
		expect(error(`${"\\sqrt{".repeat(MAX_OMML_NESTING + 1)}x${"}".repeat(MAX_OMML_NESTING + 1)}`)).toMatchObject({ code: "tooDeep" })
		expect(latexToOmml(`${"\\sqrt{".repeat(MAX_OMML_NESTING)}x${"}".repeat(MAX_OMML_NESTING)}`, false).ok).toBe(true)
	})

	it("writes nothing deeper than MAX_OMML_NESTING", () => {
		let content: OmmlNode[] = [{ kind: "run", text: "x" }]

		for (let k = 0; k <= MAX_OMML_NESTING; k++) content = [{ kind: "radical", degree: null, base: content }]

		expect(() => writeOmml(content, { display: false })).toThrow(RangeError)
		expect(() =>
			writeOmml(
				content.flatMap(node => (node.kind === "radical" ? node.base : [])),
				{ display: false }
			)
		).not.toThrow()
	})
})

describe("OMML to the LaTeX subset", () => {
	it("gives back what it read, stably", () => {
		for (const latex of [
			"\\frac{a}{b}",
			"x^2+y_1^2",
			"\\sum_{i=1}^n i^2",
			"\\sqrt[3]{x}",
			"\\left(a\\middle|b\\right)",
			"\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}",
			"\\begin{cases}x&x>0 \\\\ -x&\\text{otherwise}\\end{cases}",
			"\\alpha\\beta\\lim_{x\\to0}{\\sin x}",
			"\\mathbf{x}\\mathbb{R}",
			"\\hat{x}\\overline{ab}\\underbrace{a+b}_n",
			"\\int\\limits_0^1 f(x)\\,dx",
			"\\binom{n}{k}",
			"\\log_2 x",
			"\\operatorname{argmax}_x f",
			"\\{1,2\\}\\cup\\emptyset"
		]) {
			const first = back(latex)

			expect(first.lossy, latex).toBe(false)
			expect(omml(first.latex), latex).toBe(omml(latex))
			expect(back(first.latex), latex).toEqual(first)
		}

		expect(back("a \\\\ b", true)).toEqual({ latex: "a \\\\ b", lossy: false })
		// A control space at the end is content.
		expect(omml("a\\ ")).toBe('<m:oMath><m:r><m:t xml:space="preserve">a </m:t></m:r></m:oMath>')
		expect(back("a\\ ")).toEqual({ latex: "a\\ ", lossy: false })
		// An even run of backslashes before it escapes no space (\\ is a line break).
		expect(latexToOmml("a\\\\ ", false)).toEqual(latexToOmml("a\\\\", false))
	})

	it("flags what the subset cannot say", () => {
		const lossy = (markup: string): boolean => {
			const { document, node } = parsed(
				`<m:oMath xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${markup}</m:oMath>`
			)

			return ommlToLatex(document, node).lossy
		}

		expect(lossy(R("x"))).toBe(false)
		expect(lossy('<m:r><w:rPr><w:rFonts w:ascii="Cambria Math"/></w:rPr><m:t>x</m:t></m:r>')).toBe(false)
		// An edit keeps each run's formatting and gives new runs the first's: runs formatted alike lose nothing.
		expect(lossy('<m:r><w:rPr><w:color w:val="FF0000"/></w:rPr><m:t>x</m:t></m:r>')).toBe(false)
		expect(lossy(`<m:r><w:rPr><w:color w:val="FF0000"/></w:rPr><m:t>x</m:t></m:r>${R("y")}`)).toBe(true)
		// Ragged matrix rows come back padded.
		expect(lossy("<m:m><m:mr><m:e/><m:e/></m:mr><m:mr><m:e/></m:mr></m:m>")).toBe(true)
		expect(lossy('<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num/><m:den/></m:f>')).toBe(true)
		expect(lossy('<m:nary><m:naryPr><m:chr m:val="∑"/><m:grow m:val="1"/></m:naryPr><m:sub/><m:sup/><m:e/></m:nary>')).toBe(true)
		// Word's prescripts and box ({_a^b}x, \rect).
		expect(lossy("<m:sPre><m:sub/><m:sup/><m:e/></m:sPre>")).toBe(false)
		expect(lossy("<m:borderBox><m:e/></m:borderBox>")).toBe(false)
		expect(lossy('<m:borderBox><m:borderBoxPr><m:hideTop m:val="1"/></m:borderBoxPr><m:e/></m:borderBox>')).toBe(true)
		expect(lossy(`<w:ins w:id="1" w:author="A">${R("x")}</w:ins>`)).toBe(false)
		expect(lossy('<m:f><m:fPr><m:ctrlPr><w:del w:id="1" w:author="A"/></m:ctrlPr></m:fPr><m:num/><m:den/></m:f>')).toBe(false)
		expect(lossy('<m:e><m:argPr><m:argSz m:val="-1"/></m:argPr></m:e>')).toBe(true)
		expect(lossy('<m:r><m:rPr><m:sty m:val="bi"/></m:rPr><m:t>x</m:t></m:r>')).toBe(true)
		// A name of a function in an object, its italic runs (\operatorname reads them upright).
		expect(lossy(`<m:func><m:fName><m:bar><m:e>${R("x")}</m:e></m:bar></m:fName><m:e/></m:func>`)).toBe(true)
		expect(
			lossy(
				'<m:func><m:fName><m:bar><m:e><m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>x</m:t></m:r></m:e></m:bar></m:fName><m:e/></m:func>'
			)
		).toBe(false)
	})

	it("says the final equation of tracked changes: inserted content in, deleted content and objects out", () => {
		const { document, node } = parsed(
			'<m:oMath xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
				`<w:del w:id="1" w:author="A">${R("x")}</w:del><w:ins w:id="2" w:author="A">${R("y")}</w:ins>` +
				`<m:f><m:fPr><m:ctrlPr><w:del w:id="3" w:author="A"/></m:ctrlPr></m:fPr><m:num>${R("1")}</m:num><m:den/></m:f></m:oMath>`
		)

		expect(ommlToLatex(document, node)).toEqual({ latex: "y", lossy: false })
	})

	it("reads Word's LaTeX: \\matrix{}, \\overbar, \\rect, \\below and \\above, \\double*, prescripts", () => {
		expect(omml("\\matrix{a & b \\\\ c & d}")).toBe(omml("\\begin{matrix}a & b \\\\ c & d\\end{matrix}"))
		expect(omml("\\matrix{a & b \\cr c & d}")).toBe(omml("\\begin{matrix}a & b \\\\ c & d\\end{matrix}"))
		expect(omml("\\overbar{x}")).toBe(omml("\\overline{x}"))
		expect(omml("\\rect{x}")).toBe(`<m:oMath><m:borderBox><m:e>${R("x")}</m:e></m:borderBox></m:oMath>`)
		expect(omml("a\\below b")).toBe(omml("\\underset{b}{a}"))
		expect(omml("a\\above{b+c}")).toBe(omml("\\overset{b+c}{a}"))
		expect(omml("\\doubleR\\scriptL\\frakturg")).toBe(omml("\\mathbb{R}\\mathcal{L}\\mathfrak{g}"))
		expect(omml("\\lim\\below{n} a")).toBe(omml("\\lim_{n} a"))
		expect(omml("\\left{ x \\right}")).toBe(omml("\\left\\{ x \\right\\}"))
		expect(omml("{_a^b}x")).toBe(
			`<m:oMath><m:sPre><m:sub>${R("a")}</m:sub><m:sup>${R("b")}</m:sup><m:e>${R("x")}</m:e></m:sPre></m:oMath>`
		)

		for (const latex of ["{_a^b}x", "\\rect{x+1}", "\\operatorname{\\overline{x}}_n y"]) {
			const first = back(latex)

			expect(first.lossy, latex).toBe(false)
			expect(omml(first.latex), latex).toBe(omml(latex))
		}
	})

	it("takes time linear in the equation's length: a long run, many primes", () => {
		// The least CPU time of six runs (the first warms up), at a quarter of the length and at the whole: linear grows
		// about 4 times. Each run repeats the work until a quarter-length run costs 10 ms, well above what a thread's CPU
		// time resolves on any runner (Linux counts it at scheduler ticks), so the ratio is the work's, not the clock's.
		const growth = (work: (n: number) => void, length: number): number => {
			const least = (n: number, repeats: number): number => {
				let best = Infinity

				for (let k = 0; k < 6; k++) {
					const started = cpuMs()

					for (let r = 0; r < repeats; r++) work(n)
					best = Math.min(best, cpuMs() - started)
				}

				return best
			}

			let repeats = 1
			let quarter = least(length / 4, repeats)

			while (quarter < 10 && repeats < 1024) {
				repeats *= 2
				quarter = least(length / 4, repeats)
			}

			return least(length, repeats) / quarter
		}
		const letters = (n: number): void => {
			const { document, node } = parsed(`<m:oMath>${R("x".repeat(n))}</m:oMath>`)

			ommlToLatex(document, node)
		}

		// A run's text has no bound on its length (a quadratic join shows past 10,000 characters); LaTeX is read up to 10,000.
		expect(growth(letters, 38_400)).toBeLessThan(9)
		expect(growth(n => omml(`x${"'".repeat(n)}`), 9_600)).toBeLessThan(9)
	})

	it("diffs an edit of a long equation in bounded time and memory, as the least it can record", () => {
		const tree = (latex: string) => ommlStringTree(omml(latex)) as NonNullable<ReturnType<typeof ommlStringTree>>
		const stamp = { author: "A", date: "" }
		const long = "x".repeat(10_000)
		const before = tree(long)
		const after = tree(`y${"x".repeat(4_999)}z${"x".repeat(4_998)}y`)
		const buffers = process.memoryUsage().arrayBuffers
		const started = cpuMs()
		const changed = treeXml(diffTrees(before, after, stamp, "1", "2"))

		expect(cpuMs() - started).toBeLessThan(budget(250))
		expect(process.memoryUsage().arrayBuffers - buffers).toBeLessThan(32 * 1024 * 1024)
		expect(changed).toContain("<w:ins")

		// Compared in full where the middle is small enough: two characters swapped are one deleted, one inserted.
		const swapped = treeXml(diffTrees(tree("ab".repeat(1_000)), tree("ba".repeat(1_000)), stamp, "1", "2"))
		const text = (kind: string): string =>
			[...swapped.matchAll(new RegExp(`<w:${kind} [^>]*>(.*?)</w:${kind}>`, "g"))]
				.map(match => match[1]?.replace(/<[^>]+>/g, "") ?? "")
				.join("")

		expect(text("del")).toHaveLength(1)
		expect(text("ins")).toHaveLength(1)
	})

	it("is empty and lossy for what is no equation", () => {
		const { document, node } = parsed(R("x"))

		expect(ommlToLatex(document, node)).toEqual({ latex: "", lossy: true })
	})
})

describe("latexPreview", () => {
	it("is the tree of the OMML the LaTeX is written as", () => {
		const { document, node } = parsed(omml("\\frac{1}{x}", true))

		expect(latexPreview("\\frac{1}{x}", true)).toEqual({ tree: ommlToMathTree(document, node), error: null })
		expect(latexPreview("", false)).toEqual({ tree: null, error: null })
		expect(latexPreview("\\frac{1", false)).toEqual({ tree: null, error: { code: "unbalanced", offset: 5, token: "{" } })
	})
})

// Every math element of an equation is one Office Math has; the tree builds and is valid.
function wellFormed(latex: string, display: boolean): void {
	const written = latexToOmml(latex, display)

	if (!written.ok) return

	const { document, node } = parsed(written.omml)

	for (let at = node; at < document.count; at++) {
		if (document.kinds[at] === NodeKind.Element) expect(OMML_ELEMENTS.has(document.localName(at)), latex).toBe(true)
	}

	const tree = ommlToMathTree(document, node)

	if (tree !== undefined) assertMathTree(tree)
}

describe("fuzzed LaTeX", () => {
	it("never makes invalid OMML", () => {
		const pieces = [
			"x",
			"1",
			"+",
			"{",
			"}",
			"^",
			"_",
			"'",
			"&",
			"\\\\",
			"\\frac",
			"\\sqrt",
			"[",
			"]",
			"\\left(",
			"\\right)",
			"\\middle|",
			"\\sum",
			"\\limits",
			"\\int",
			"\\lim",
			"\\sin",
			"\\begin{pmatrix}",
			"\\end{pmatrix}",
			"\\begin{cases}",
			"\\end{cases}",
			"\\text{a b}",
			"\\mathbf",
			"\\hat",
			"\\underbrace",
			"\\overset",
			"\\alpha",
			"\\,",
			" ",
			"<",
			"\\{",
			"%",
			"\n",
			"\u{1D400}",
			"\ud800"
		]
		const rand = rng(20261013)
		let read = 0

		for (let k = 0; k < 4000; k++) {
			let latex = ""

			for (let n = Math.floor(rand() * 24); n > 0; n--) latex += pieces[Math.floor(rand() * pieces.length)] ?? ""

			const display = rand() < 0.5

			if (latexToOmml(latex, display).ok) read++

			wellFormed(latex, display)

			const preview = latexPreview(latex, display)

			expect(preview.tree === null || preview.error === null).toBe(true)
		}

		expect(read).toBeGreaterThan(200)
	})
})

// ---- the corpus's equations -------------------------------------------------------------------------------

function corpusFiles(): string[] {
	const files: string[] = []

	for (const extension of ["docx", "docm", "dotx", "dotm"]) {
		const directory = join(CORPUS, extension)

		if (existsSync(directory)) for (const name of readdirSync(directory).sort()) files.push(join(directory, name))
	}

	return files
}

describe.skipIf(!existsSync(CORPUS))("OMML of the real-world corpus as LaTeX", () => {
	it("reads every equation back as the same equation, or says it is lossy", { timeout: 300_000 }, async () => {
		let equations = 0
		let files = 0
		const failures: string[] = []

		for (const file of corpusFiles()) {
			let opc: OpcPackage

			try {
				opc = await OpcPackage.open(bytesSource(new Uint8Array(readFileSync(file))))
			} catch {
				continue
			}

			let found = false

			for (const entry of opc.zip.entries) {
				if (!entry.name.startsWith("word/") || !entry.name.endsWith(".xml")) continue
				if (!new TextDecoder().decode(await opc.read(entry.name)).includes(":oMath")) continue

				let document: XmlDocument

				try {
					document = await opc.xml(entry.name)
				} catch {
					continue
				}

				const namespaces = new Namespaces(document, { lenient: true })
				const isMath = (node: number, local: string): boolean =>
					document.kinds[node] === NodeKind.Element &&
					document.localName(node) === local &&
					(namespaces.elementUri(node) ?? "").endsWith("math")

				for (let node = 0; node < document.count; node++) {
					const display = isMath(node, "oMathPara")

					if (!display && (!isMath(node, "oMath") || isMath(document.parent(node), "oMathPara"))) continue

					equations++
					found = true

					const latex = ommlToLatex(document, node, { namespaces })
					const written = latexToOmml(latex.latex, display)
					const name = `${file.slice(CORPUS.length + 1)}#${String(node)}`

					if (!written.ok) {
						if (!latex.lossy && latex.latex !== "")
							failures.push(`${name}: ${latex.latex} does not read (${written.error.code})`)

						continue
					}

					// What an edit of the equation to this LaTeX writes (ommlTrack.ts: its formatting kept).
					const before = ommlTree(document, node, namespaces)
					const after = ommlStringTree(written.omml)
					const edited =
						after === undefined
							? written.omml
							: treeXml(
									diffTrees(
										before,
										withRunProperties(after, firstRunProperties(before) ?? equationRunProperties(undefined)),
										{ author: "", date: "" },
										"0",
										"0",
										false
									)
								)
					const again = parsedTracked(edited)
					const same =
						JSON.stringify(ommlToMathTree(document, node, { namespaces })) ===
						JSON.stringify(ommlToMathTree(again.document, again.node))

					if (!same && !latex.lossy) failures.push(`${name}: ${latex.latex} reads back as another equation`)
					// What reads back is stable from then on.
					if (ommlToLatex(again.document, again.node).latex !== latex.latex && !latex.lossy)
						failures.push(`${name}: ${latex.latex} is not stable`)
				}
			}

			if (found) files++
		}

		expect(failures).toEqual([])
		expect(files).toBeGreaterThanOrEqual(10)
		expect(equations).toBeGreaterThanOrEqual(30)
	})
})
