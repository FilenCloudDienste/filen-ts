import { describe, expect, it } from "vitest"
import { EVAL_CASES } from "../cases"
import { FORMULA_CASES } from "../cases/formula"
import { INJECTION_CASES } from "../cases/injection"
import { TRANSFORM_CASES } from "../cases/transform"
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
		expect(selection.transformCaseIds).toEqual(TRANSFORM_CASES.map(item => item.id))
	})

	it("runs only the transform suite with --suite transform", () => {
		const selection = resolveRun({ suite: "transform" })

		expect(selection.mainCaseIds).toEqual([])
		expect(selection.injectionCaseIds).toEqual([])
		expect(selection.transformCaseIds).toEqual(TRANSFORM_CASES.map(item => item.id))
	})

	it("applies --languages, --categories and --sample to the transform suite", () => {
		const selection = resolveRun({
			suite: "transform",
			languages: "de,ja",
			categories: "transform_translate,transform_shorten",
			sample: "2"
		})
		const kept = TRANSFORM_CASES.filter(
			item => ["de", "ja"].includes(item.lang) && ["transform_translate", "transform_shorten"].includes(item.category)
		)

		expect(selection.transformCaseIds).toEqual(kept.filter((_, index) => index % 2 === 0).map(item => item.id))
	})

	it("keeps a transform category out of the main suite and a main one out of the transform suite", () => {
		const transformOnly = resolveRun({ categories: "transform_injection" })

		expect(transformOnly.mainCaseIds).toEqual([])
		expect(transformOnly.transformCaseIds).toEqual(
			TRANSFORM_CASES.filter(item => item.category === "transform_injection").map(item => item.id)
		)
		expect(resolveRun({ categories: "simple" }).transformCaseIds).toEqual([])
	})

	it("runs only the formula suite with --suite formula, and keeps its categories to it", () => {
		const selection = resolveRun({ suite: "formula" })

		expect(selection.mainCaseIds).toEqual([])
		expect(selection.transformCaseIds).toEqual([])
		expect(selection.formulaCaseIds).toEqual(FORMULA_CASES.map(item => item.id))
		expect(resolveRun({}).formulaCaseIds).toEqual(FORMULA_CASES.map(item => item.id))

		const injection = resolveRun({ categories: "formula_injection" })

		expect(injection.mainCaseIds).toEqual([])
		expect(injection.transformCaseIds).toEqual([])
		expect(injection.formulaCaseIds).toEqual(FORMULA_CASES.filter(item => item.category === "formula_injection").map(item => item.id))
	})

	it("accepts a transform case id", () => {
		const id = TRANSFORM_CASES[0]?.id ?? ""
		const selection = resolveRun({ cases: id })

		expect(selection.transformCaseIds).toEqual([id])
		expect(selection.mainCaseIds).toEqual([])
	})

	it("rejects a selection the transform suite cannot keep", () => {
		expect(() => resolveRun({ suite: "transform", categories: "simple" })).toThrow(/keeps no case/)
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
