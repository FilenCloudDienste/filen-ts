import { describe, expect, it } from "vitest"
import { MAX_COORDINATE, parseEmu, parseFraction } from "../core/drawingml/reader"

// DrawingML unit parsers: ST_Percentage / ST_PositiveFixedPercentage fractions and ST_Coordinate lengths.

describe("parseFraction", () => {
	it("reads thousandths of a percent and percent strings", () => {
		expect(parseFraction("50000", -1)).toBe(0.5)
		expect(parseFraction(" 100000 ", -1)).toBe(1)
		expect(parseFraction("50%", -1)).toBe(0.5)
		expect(parseFraction("12.5%", -1)).toBe(0.125)
	})

	it("falls back on garbage", () => {
		expect(parseFraction("garbage", -1)).toBe(-1)
		expect(parseFraction("", -1)).toBe(-1)
	})
})

describe("parseEmu", () => {
	it("reads plain EMU", () => {
		expect(parseEmu("914400", -1)).toBe(914400)
		expect(parseEmu(" -12700 ", -1)).toBe(-12700)
	})

	it("reads universal measures", () => {
		expect(parseEmu("1in", -1)).toBe(914400)
		expect(parseEmu("2.5cm", -1)).toBe(900000)
		expect(parseEmu("10mm", -1)).toBe(360000)
		expect(parseEmu(".5pt", -1)).toBe(6350)
		expect(parseEmu("1pc", -1)).toBe(152400)
		expect(parseEmu("-1pi", -1)).toBe(-152400)
	})

	it("clamps beyond the maximum coordinate", () => {
		expect(parseEmu("1e20", -1)).toBe(MAX_COORDINATE)
		expect(parseEmu("-1e20", -1)).toBe(-MAX_COORDINATE)
		expect(parseEmu("40000000in", -1)).toBe(MAX_COORDINATE)
	})

	it("falls back on overflow, empty and unknown units", () => {
		expect(parseEmu("1e400", -1)).toBe(-1)
		expect(parseEmu(`${"9".repeat(400)}in`, -1)).toBe(-1)
		expect(parseEmu("", -1)).toBe(-1)
		expect(parseEmu("   ", -1)).toBe(-1)
		expect(parseEmu("2px", -1)).toBe(-1)
		expect(parseEmu("in", -1)).toBe(-1)
		expect(parseEmu("1inch", -1)).toBe(-1)
		expect(parseEmu("x1in", -1)).toBe(-1)
	})
})
