import { describe, expect, it } from "vitest"
import { PropsReader, parseUniversalMeasure, parseWidth } from "../../core/docx/props/index"
import { find, wordPart } from "../docxFixtures"
import { budget, cpuMs } from "../timing"

// Lengths and percentages come from the document's attributes: no value may make reading it take more than
// linear time (a number pattern that split a run of digits between two groups took seconds for 80,000 digits).

function timed<T>(run: () => T): { value: T; ms: number } {
	const started = cpuMs()
	const value = run()

	return { value, ms: cpuMs() - started }
}

function width(w: string): number {
	const document = wordPart("document", `<w:tblW w:w="${w}" w:type="pct"/>`)

	return parseWidth(PropsReader.for(document), find(document, "w:tblW")).value
}

const DIGITS = "1".repeat(200_000)

describe("measures from documents", () => {
	it("refuses a long run of digits quickly", () => {
		for (const text of [DIGITS, `${DIGITS}x`, `${DIGITS}.5x`]) {
			const measured = timed(() => parseUniversalMeasure(text, 20))

			expect(measured.value).toBeUndefined()
			expect(measured.ms).toBeLessThan(budget(50))
		}

		for (const text of [`${DIGITS}x`, `${DIGITS}1%x`]) {
			const read = timed(() => width(text))

			expect(read.value).toBe(0)
			expect(read.ms).toBeLessThan(budget(250))
		}
	})

	it("still reads the measures files write", () => {
		expect(parseUniversalMeasure("12pt", 20)).toBe(240)
		expect(parseUniversalMeasure(" 1.5cm ", 20)).toBe(850)
		expect(parseUniversalMeasure(".5in", 20)).toBe(720)
		expect(parseUniversalMeasure("-2pt", 20)).toBe(-40)
		expect(parseUniversalMeasure("5.pt", 20)).toBeUndefined()
		expect(parseUniversalMeasure("5", 20)).toBeUndefined()
		expect(width("50%")).toBe(2500)
		expect(width(" .5 % ")).toBe(25)
		expect(width("5.%")).toBe(0)
		expect(width("5000")).toBe(5000)
	})
})
