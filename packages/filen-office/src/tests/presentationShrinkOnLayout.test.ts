import { describe, expect, it } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { TextBody } from "../core/presentation/model"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody, type BodyContext } from "../core/presentation/text/resolve"
import { MeasureCache } from "../core/text/index"
import { FakeMeasurer, testFont } from "./textFixtures"

// A body that shrinks its text on overflow with no scale of its own (ODF style:shrink-to-fit, which LibreOffice
// scales as it lays the text out): laid out at the largest scale its text fits the box at; one that fits stays at
// its size, and a scale the file gives (a:normAutofit fontScale) is drawn as given.

const CONTEXT: BodyContext = { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }
const BOX = { width: 200, height: 60 }

function body(text: string, fontScale?: number): TextBody {
	return {
		bodyPr: { autofit: "normal", ...(fontScale === undefined ? {} : { fontScale }), insets: { left: 0, top: 0, right: 0, bottom: 0 } },
		paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: { sz: 4000 } }] }]
	}
}

const LONG = "a shrinking body of text that is far too long for its box at forty points"

describe("text shrunk on layout", () => {
	it("an overflowing body: laid out at a scale its text fits the box at", () => {
		const given = layoutBody(resolveBody(body(LONG), CONTEXT), BOX, ENV)
		const shrunk = layoutBody(resolveBody(body(LONG), CONTEXT), BOX, ENV, { shrinkOnLayout: true })

		expect(given.height).toBeGreaterThan(BOX.height)
		// Within LibreOffice's allowance of its box (4.5%), and shrunk no further: a tenth larger again runs past it.
		expect(shrunk.height).toBeLessThanOrEqual(BOX.height * 1.045)
		expect(shrunk.scale).toBeGreaterThan(0.01)
		expect(layoutBody(resolveBody(body(LONG, Math.min(1, shrunk.scale * 1.1)), CONTEXT), BOX, ENV).height).toBeGreaterThan(
			BOX.height * 1.045
		)
	})

	it("a body that fits stays at its size", () => {
		const tall = { width: 200, height: 120 }
		const fits = layoutBody(resolveBody(body("short"), CONTEXT), tall, ENV, { shrinkOnLayout: true })

		expect(fits.scale).toBe(1)
		expect(fits.height).toBe(layoutBody(resolveBody(body("short"), CONTEXT), tall, ENV).height)
	})

	it("without it, the file's scale is drawn as given", () => {
		expect(layoutBody(resolveBody(body(LONG, 0.5), CONTEXT), BOX, ENV).scale).toBe(0.5)
	})

	// LibreOffice 7.5 leaves trailing empty paragraphs out of the fit (measured: "textbox" alone and "textbox" with two
	// empty paragraphs after it in the same box both shrink to 59%; one with two words on three lines to 22%).
	it("trailing empty paragraphs are not fitted: a body that fits without them keeps its size", () => {
		const tall = { width: 200, height: 70 }
		const trailing: TextBody = {
			...body("short"),
			paragraphs: [
				...body("short").paragraphs,
				{ pPr: {}, runs: [], endRPr: { sz: 4000 } },
				{ pPr: {}, runs: [], endRPr: { sz: 4000 } }
			]
		}
		const alone = layoutBody(resolveBody(body("short"), CONTEXT), tall, ENV, { shrinkOnLayout: true })
		const withTrailing = layoutBody(resolveBody(trailing, CONTEXT), tall, ENV, { shrinkOnLayout: true })

		expect(layoutBody(resolveBody(trailing, CONTEXT), tall, ENV).overflow).toBe(true)
		expect(alone.scale).toBe(1)
		expect(withTrailing.scale).toBe(1)
	})

	it("trailing empty paragraphs are not fitted: an overflowing body shrinks as far as without them", () => {
		const trailing: TextBody = {
			...body(LONG),
			paragraphs: [...body(LONG).paragraphs, { pPr: {}, runs: [], endRPr: { sz: 4000 } }, { pPr: {}, runs: [], endRPr: { sz: 4000 } }]
		}

		expect(layoutBody(resolveBody(trailing, CONTEXT), BOX, ENV, { shrinkOnLayout: true }).scale).toBe(
			layoutBody(resolveBody(body(LONG), CONTEXT), BOX, ENV, { shrinkOnLayout: true }).scale
		)
	})

	// LibreOffice 7.5 shrinks the glyphs first and keeps the line pitch (tika__testODP_NPE slide 11: its text at 92%,
	// its lines 1.2 times the unscaled size apart): a body that fits by rewrapping keeps its lines' pitch.
	it("shrinks the glyphs first, keeping the lines' pitch", () => {
		const text = "a body that wraps onto more lines at forty points in this box of six hundred pixels"
		const full = layoutBody(resolveBody(body(text), CONTEXT), { width: 600, height: 1000 }, ENV)
		const pitch = full.height / full.page.page.lineCount
		// Room for one line fewer than it takes at full size.
		const wide = { width: 600, height: pitch * (full.page.page.lineCount - 1) }
		const shrunk = layoutBody(resolveBody(body(text), CONTEXT), wide, ENV, { shrinkOnLayout: true })

		expect(full.page.page.lineCount).toBeGreaterThan(1)
		expect(shrunk.scale).toBeLessThan(1)
		expect(shrunk.page.page.lineCount).toBeLessThan(full.page.page.lineCount)
		expect(shrunk.height / shrunk.page.page.lineCount).toBeCloseTo(pitch, 1)
	})
})
