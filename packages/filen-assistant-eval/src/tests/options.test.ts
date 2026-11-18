import { describe, expect, it } from "vitest"
import { EVAL_CASES } from "../cases"
import { INJECTION_CASES } from "../cases/injection"
import { resolveRun } from "../options"

const MAIN_IDS = new Set(EVAL_CASES.map(item => item.id))
const INJECTION_ONLY = INJECTION_CASES.find(item => !MAIN_IDS.has(item.id))?.id ?? ""

describe("resolveRun", () => {
	it("defaults to both suites with the shipping presets", () => {
		const selection = resolveRun({})

		expect(selection.mainPresets).toEqual(["shipped"])
		expect(selection.injectionPresets).toEqual(["shipped", "loop"])
		expect(selection.mainCaseIds).toEqual(EVAL_CASES.map(item => item.id))
		expect(selection.injectionCaseIds).toEqual(INJECTION_CASES.map(item => item.id))
	})

	it("accepts a case id that exists only in the injection suite", () => {
		expect(INJECTION_ONLY).not.toBe("")

		const selection = resolveRun({
			cases: INJECTION_ONLY
		})

		expect(selection.mainCaseIds).toEqual([])
		expect(selection.injectionCaseIds).toEqual([INJECTION_ONLY])
	})

	it("rejects an unknown preset", () => {
		expect(() =>
			resolveRun({
				presets: "shiped,loop"
			})
		).toThrow(/Unknown preset "shiped"/)
		expect(() =>
			resolveRun({
				"main-presets": "nope"
			})
		).toThrow(/Unknown preset "nope"/)
	})

	it("rejects a given but empty preset list", () => {
		expect(() =>
			resolveRun({
				presets: ""
			})
		).toThrow(/--presets names no preset/)
		expect(() =>
			resolveRun({
				presets: ","
			})
		).toThrow(/--presets names no preset/)
		expect(() =>
			resolveRun({
				"main-presets": " "
			})
		).toThrow(/--main-presets names no preset/)
	})

	it.each([
		[{ categories: "" }, /--categories names no category/],
		[{ categories: "," }, /--categories names no category/],
		[{ languages: "" }, /--languages names no language/],
		[{ cases: " " }, /--cases names no case/]
	])("rejects a given but empty list %o", (values, message) => {
		expect(() => resolveRun(values)).toThrow(message)
	})

	it("rejects an unknown suite", () => {
		expect(() =>
			resolveRun({
				suite: "injections"
			})
		).toThrow(/Unknown suite "injections"/)
	})

	it.each(["0", "abc", "-1", "1.5"])("rejects --sample %s", sample => {
		expect(() =>
			resolveRun({
				sample
			})
		).toThrow(/--sample/)
	})

	it("rejects an unknown category", () => {
		expect(() =>
			resolveRun({
				categories: "safty"
			})
		).toThrow(/Unknown category "safty"/)
	})

	it("rejects an unknown language", () => {
		expect(() =>
			resolveRun({
				languages: "en,xx"
			})
		).toThrow(/Unknown language "xx"/)
	})

	it("rejects an unknown case id", () => {
		expect(() =>
			resolveRun({
				cases: "no-such-case"
			})
		).toThrow(/Unknown case "no-such-case"/)
	})

	it("rejects a selection that keeps no case", () => {
		expect(() =>
			resolveRun({
				suite: "main",
				cases: INJECTION_ONLY
			})
		).toThrow(/keeps no case/)
	})
})
