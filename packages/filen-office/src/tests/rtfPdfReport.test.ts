import { describe, expect, it } from "vitest"
import type { FontExtents, TextMeasurer } from "../core/text/index"
import type { DocxEngineServices } from "../dom/docx/index"
import { exportDocxPdf } from "../dom/docx/pdf"
import { reportOf } from "../dom/docx/pdfClient"
import { workerHarness } from "./docxEncryptedFixtures"
import { pdfAssets } from "./docxPdfFixtures"
import { PNG, latin1 } from "./rtfWriteFixtures"

// What an RTF file shows that the package it reads as leaves out (a shape with nothing to draw it by, an object without its result...) reaches the
// PDF's report as the conversions' reports have it, so the export says it was simplified; what no page shows (an
// unknown destination such as the generator's name) does not.

const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => new Promise(resolve => setTimeout(resolve, 0)),
		sliceMs: 8
	}
}

const HEADER = "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}{\\*\\generator Some Writer;}"
const MATH = latin1(
	`${HEADER}\\pard\\plain Before\\par\\pard\\plain {\\mmath{\\*\\moMathPara{\\*\\moMath{\\*\\mf{\\*\\mnum a}{\\*\\mden b}}}}}\\par\\pard\\plain After\\par}`
)
const OBJECT = latin1(`${HEADER}\\pard {\\object\\objemb{\\*\\objclass Paint}{\\*\\objdata 0102}}\\par}`)
const PLAIN = latin1(`${HEADER}\\pard\\plain Only text\\par}`)

async function exported(rtf: Uint8Array): Promise<ReturnType<typeof reportOf>> {
	const harness = workerHarness()

	try {
		const opened = await harness.pool.rtf.open(rtf)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		try {
			const result = await exportDocxPdf(await opened.document.take(), services(), pdfAssets, {
				options: { title: "letter", deterministic: true, untranslated: opened.document.untranslated },
				signal: { aborted: false }
			})

			return reportOf(result.report)
		} finally {
			opened.document.release()
		}
	} finally {
		harness.dispose()
	}
}

// The count the PDF warns with: what its pages lack.
async function untranslated(body: string): Promise<number> {
	const harness = workerHarness()

	try {
		const opened = await harness.pool.rtf.open(latin1(`${HEADER}${body}}`))

		if (opened.kind !== "opened") throw new Error(opened.kind)

		opened.document.release()

		return opened.document.untranslated
	} finally {
		harness.dispose()
	}
}

const HEX = [...PNG].map(byte => byte.toString(16).padStart(2, "0")).join("")
const SHAPE = (properties: string, text = ""): string =>
	`\\pard\\plain {\\shp{\\*\\shpinst\\shpleft0\\shptop0\\shpright1440\\shpbottom1440${properties}${text}}}Text\\par`

describe("the PDF of an RTF file", () => {
	it("counts only content its pages lack: never a shape drawn by its picture, text or WordArt, a field's result or a state word", async () => {
		const picture = SHAPE(`{\\sp{\\sn shapeType}{\\sv 75}}{\\sp{\\sn pib}{\\sv {\\pict\\pngblip\\picw2\\pich2 ${HEX}}}}`)
		const textBox = SHAPE("{\\sp{\\sn shapeType}{\\sv 202}}", "{\\shptxt \\pard\\plain Boxed\\par}")
		const wordArt = SHAPE("{\\sp{\\sn shapeType}{\\sv 136}}{\\sp{\\sn gtextUNICODE}{\\sv Art}}")
		const formField =
			"\\pard {\\field{\\*\\fldinst { FORMTEXT }{{\\*\\formfield{\\fftype0{\\*\\ffname Title}}}}}{\\fldrslt {Shown}}}\\par"
		const object =
			"\\pard {\\object\\objemb{\\*\\objclass Paint}{\\*\\objdata 0102}{\\result {\\pict\\pngblip\\picw2\\pich2 " + HEX + "}}}\\par"

		expect(await untranslated(picture + textBox + wordArt + formField + object + "\\pard\\plain\\lisb120 Indented\\par")).toBe(0)
		// A rectangle is drawn by its preset geometry; a freeform without vertices (drawn by nothing) and an object without
		// its result are lacking.
		expect(await untranslated(SHAPE("{\\sp{\\sn shapeType}{\\sv 1}}"))).toBe(0)
		expect(await untranslated(SHAPE("{\\sp{\\sn shapeType}{\\sv 0}}"))).toBe(1)
		expect(await untranslated("\\pard {\\object\\objemb{\\*\\objclass Paint}{\\*\\objdata 0102}}\\par")).toBe(1)
		expect(
			await untranslated(
				"\\pard {\\shpgrp{\\*\\shpinst{\\shp{\\*\\shpinst{\\sp{\\sn shapeType}{\\sv 0}}}}" +
					"{\\shp{\\*\\shpinst{\\sp{\\sn shapeType}{\\sv 202}}{\\shptxt Inside\\par}}}}}\\par"
			)
		).toBe(1)
	})

	it("reports nothing for an equation, which its package holds as Office Math", async () => {
		expect((await exported(MATH)).refused).toEqual([])
	})

	it("reports what its package leaves out as content left out of the PDF", async () => {
		expect((await exported(OBJECT)).refused).toEqual([["untranslated", 1]])
	})

	it("reports nothing for a file whose package holds all it shows (unknown destinations aside)", async () => {
		expect((await exported(PLAIN)).refused).toEqual([])
	})
})
