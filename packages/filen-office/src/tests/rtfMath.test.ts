import { strFromU8, unzipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { ommlToLatex } from "../core/math/toLatex"
import { readRtf, type RtfReadResult } from "../core/rtf/index"
import { NodeKind, parseXml, type XmlDocument } from "../core/xml/index"
import { budget, cpuMs } from "./timing"

// RTF equations (RTF 1.9.1 "Math": \mmath, \moMath and the \m words naming Office Math elements) read as the Office
// Math Word opens them as, their groups kept in the source.

function bytes(text: string): Uint8Array {
	const out = new Uint8Array(text.length)

	for (let k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 0xff

	return out
}

async function read(rtf: string): Promise<RtfReadResult> {
	const result = await readRtf(bytes(rtf))

	if (!result.ok) throw new Error(result.reason)

	return result
}

function documentXml(result: RtfReadResult): string {
	return strFromU8(unzipSync(result.docx)["word/document.xml"] ?? new Uint8Array())
}

// The LaTeX of each top-level equation of the document.
function equations(xml: string): string[] {
	const document: XmlDocument = parseXml(new TextEncoder().encode(xml))
	const out: string[] = []

	for (let node = 0; node < document.count; node++) {
		if (document.kinds[node] !== NodeKind.Element) continue

		const local = document.localName(node)

		if (local !== "oMathPara" && local !== "oMath") continue
		if (local === "oMath" && document.localName(document.parent(node)) === "oMathPara") continue

		out.push(ommlToLatex(document, node).latex)
	}

	return out
}

const HEADER = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}{\\f34 Cambria Math;}}"
// As Word writes them: \* before each element, runs in \mr with their character properties.
const FRACTION =
	"{\\mmath{\\*\\moMathPara{\\*\\moMath{\\*\\mf{\\*\\mfPr{\\mctrlPr\\i\\f34 }}{\\*\\mnum{\\mr\\i\\f34 a}}{\\*\\mden{\\mr\\i\\f34 b}}}}}}"
const SCRIPTS =
	"{\\mmath{\\*\\moMath{\\*\\msSup{\\*\\msSupPr{\\mctrlPr\\i\\f34 }}{\\*\\me{\\mr\\i\\f34 x}}{\\*\\msup{\\mr\\i\\f34 2}}}" +
	"{\\mr\\f34 +}{\\*\\msSub{\\*\\me{\\mr\\i\\f34 y}}{\\*\\msub{\\mr\\i\\f34 1}}}}}"
const DELIMITED =
	"{\\mmath{\\*\\moMath{\\*\\md{\\*\\mdPr{\\mbegChr [}{\\mendChr ]}}{\\*\\me{\\*\\mrad{\\*\\mradPr{\\mdegHide on}}{\\*\\mdeg}{\\*\\me{\\mr\\i\\f34 z}}}}}}}"

describe("RTF equations", () => {
	it("reads a display fraction as an m:oMathPara between the paragraph's text, kept in the source", async () => {
		const result = await read(`${HEADER}\\pard\\plain Before ${FRACTION} after\\par}`)
		const xml = documentXml(result)

		expect(equations(xml)).toEqual(["\\frac{a}{b}"])
		expect(xml).toMatch(/<w:t xml:space="preserve">Before <\/w:t><\/w:r><m:oMathPara xmlns:m="[^"]+"><m:oMath><m:f>/u)
		// The run keeps its character properties (Word writes w:rPr in math runs).
		expect(xml).toContain('<m:r><w:rPr><w:rFonts w:ascii="Cambria Math"')
		expect(result.undrawn).toBe(0)

		const math = result.preserved.filter(entry => entry.kind === "math")
		const source = strFromU8(bytes(`${HEADER}\\pard\\plain Before ${FRACTION} after\\par}`))

		expect(math.map(entry => source.slice(entry.start, entry.end))).toEqual([FRACTION])
		// The equation's group lies inside its paragraph's source range.
		expect(result.paragraphs[0]?.start).toBeLessThanOrEqual(math[0]?.start ?? -1)
	})

	it("reads scripts, runs between objects, delimiters with their characters and a radical's hidden degree", async () => {
		const xml = documentXml(await read(`${HEADER}\\pard ${SCRIPTS}\\par\\pard ${DELIMITED}\\par}`))

		expect(equations(xml)).toEqual(["x^2+y_1", "\\left[\\sqrt{z}\\right]"])
		expect(xml).toContain('<m:begChr m:val="["/><m:endChr m:val="]"/>')
		expect(xml).toContain('<m:degHide m:val="on"/>')
	})

	it("reads \\u characters in runs, a property given as a parameter and text outside runs", async () => {
		const xml = documentXml(
			await read(
				`${HEADER}\\pard {\\mmath{\\*\\moMath{\\*\\mnary{\\*\\mnaryPr{\\mchr \\u8721\\'3f}\\msubHide1}{\\*\\msub}{\\*\\msup{\\mr n}}{\\*\\me{\\mr\\i k}}}}}\\par` +
					"\\pard {\\*\\moMath{\\*\\mf{\\*\\mnum 1}{\\*\\mden 2}}}\\par}"
			)
		)

		expect(xml).toContain('<m:chr m:val="∑"/><m:subHide m:val="on"/>')
		expect(equations(xml)).toEqual(["\\sum^n k", "\\frac{1}{2}"])
	})

	it("skips a fallback picture and unknown groups inside an equation", async () => {
		const result = await read(
			`${HEADER}\\pard {\\mmath{\\*\\mmathPict{\\pict\\pngblip 00}}{\\*\\moMath{\\*\\mmystery{\\mr q}}{\\mr\\i w}}}\\par}`
		)
		const xml = documentXml(result)

		expect(equations(xml)).toEqual(["w"])
		expect(xml).not.toContain("<w:drawing>")
		expect(result.preserved.map(entry => entry.kind)).toEqual(["math"])
	})

	it("shows no equation where no text shows: a field's instruction keeps it in the source only", async () => {
		const inField = await read(`${HEADER}\\pard {\\field{\\*\\fldinst {\\mmath{\\*\\moMath{\\mr x}}}}{\\fldrslt R}}\\par}`)

		expect(inField.undrawn).toBe(0)
		expect(inField.preserved.map(entry => entry.kind)).toEqual(["math"])
		expect(documentXml(inField)).not.toContain("<m:oMath")
	})

	it("reads many equations in time linear in their count", async () => {
		const one = `\\pard ${FRACTION}${SCRIPTS}\\par`
		// The least CPU time of a few reads.
		const spent = async (count: number): Promise<number> => {
			const rtf = `${HEADER}${one.repeat(count)}}`
			let least = Infinity

			for (let run = 0; run < 3; run++) {
				const start = cpuMs()

				await read(rtf)
				least = Math.min(least, cpuMs() - start)
			}

			return least
		}
		const small = await spent(300)
		const large = await spent(3000)

		// Ten times the equations: well under a hundred times the time.
		expect(large).toBeLessThan(budget(Math.max(small, 1) * 30))
		expect(large).toBeLessThan(budget(1500))
	})
})
