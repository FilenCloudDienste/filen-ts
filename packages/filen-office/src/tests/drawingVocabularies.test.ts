import { describe, expect, it } from "vitest"
import { drawingTheme } from "../core/drawingml/color"
import { DrawingList, dashPreset, patternPreset } from "../core/drawingml/displayList"
import { readFillElement, shapeLine } from "../core/drawingml/fill"
import { D, drawingReader } from "../core/drawingml/reader"
import { resolveTextFill, resolveTextLine } from "../core/presentation/text/color"
import { parseXml } from "../core/xml/index"
import { NS } from "./fixtures/presentation/renderDeck"

// Closed DrawingML vocabularies read from documents: a known name is kept, an unknown one falls back, the same way
// for shape fills and lines (core/drawingml/fill.ts) and text fills and outlines (core/presentation/text/color.ts).

const BLACK = { kind: "srgb", rgb: "000000" } as const

function shape(spPr: string): { list: DrawingList; fill: number | undefined; line: ReturnType<typeof shapeLine> } {
	const document = parseXml(new TextEncoder().encode(`<p:sp ${NS}><p:spPr>${spPr}</p:spPr></p:sp>`))
	const reader = drawingReader(document)
	const list = new DrawingList()
	const context = { list, theme: drawingTheme(undefined, () => undefined), images: () => undefined, effects: true }
	const node = reader.child(document.documentElement(), D.P, "spPr")
	const pattern = reader.child(node, D.A, "pattFill")

	return {
		list,
		fill: pattern < 0 ? undefined : readFillElement(context, reader, pattern),
		line: shapeLine(context, reader, reader.child(node, D.A, "ln"), undefined)
	}
}

function shapePattern(preset: string): unknown {
	const { list, fill } = shape(`<a:pattFill prst="${preset}"><a:fgClr><a:srgbClr val="000000"/></a:fgClr></a:pattFill>`)
	const paint = fill === undefined ? undefined : list.paints[fill]

	return paint?.kind === "pattern" ? paint.pattern : undefined
}

function textPattern(preset: string): unknown {
	const fill = resolveTextFill({ kind: "pattern", preset, fg: BLACK, bg: BLACK }, () => 0x000000ff, 0x000000ff)

	return fill.kind === "paint" && fill.paint.kind === "pattern" ? fill.paint.pattern : undefined
}

function textDash(dash: string | undefined): unknown {
	return resolveTextLine(
		{ fill: { kind: "solid", color: BLACK }, ...(dash === undefined ? {} : { dash }) },
		() => 0x000000ff,
		() => 0
	)?.dash
}

describe("DrawingML preset vocabularies", () => {
	it("narrows pattern and dash names, falling back to pct50 and solid", () => {
		expect(patternPreset("dkUpDiag")).toBe("dkUpDiag")
		expect(patternPreset("noSuchPattern")).toBe("pct50")
		expect(patternPreset("constructor")).toBe("pct50")
		expect(dashPreset("lgDashDot")).toBe("lgDashDot")
		expect(dashPreset("noSuchDash")).toBe("solid")
		expect(dashPreset("constructor")).toBe("solid")
		expect(dashPreset(undefined)).toBe("solid")
	})

	it("reads shape pattern fills and line dashes through the shared vocabularies", () => {
		expect(shapePattern("zigZag")).toBe("zigZag")
		expect(shapePattern("noSuchPattern")).toBe("pct50")

		const line = (preset: string): unknown => {
			const { list, line } = shape(
				`<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill><a:prstDash val="${preset}"/></a:ln>`
			)

			return line === undefined ? undefined : list.strokes[line.stroke]?.dash
		}

		expect(line("sysDot")).toBe("sysDot")
		expect(line("noSuchDash")).toBe("solid")
	})

	it("reads text pattern fills and outline dashes through the shared vocabularies", () => {
		expect(textPattern("smGrid")).toBe("smGrid")
		expect(textPattern("noSuchPattern")).toBe("pct50")
		expect(textDash("dashDot")).toBe("dashDot")
		expect(textDash("noSuchDash")).toBe("solid")
		expect(textDash(undefined)).toBe("solid")
	})
})
