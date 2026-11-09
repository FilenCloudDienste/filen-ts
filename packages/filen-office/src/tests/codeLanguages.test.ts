import { describe, expect, it } from "vitest"
import { CODE_LANGUAGES, codeLanguageExtensions, codeLanguageForExtension, isCodeLanguageId } from "../core/code/index"

describe("code language table", () => {
	it("covers mobile's 228 extensions (two of them only reachable lowercased, .text left plain) plus web's own seven", () => {
		expect(codeLanguageExtensions()).toHaveLength(225 + 8)
	})

	it("leaves .text as plain text rather than LaTeX", () => {
		expect(codeLanguageForExtension("text")).toBeNull()
		expect(codeLanguageExtensions()).not.toContain("text")
	})

	it("keys every extension lowercased and without its dot, each to a known language", () => {
		for (const extension of codeLanguageExtensions()) {
			expect(extension).toBe(extension.toLowerCase())
			expect(extension.startsWith(".")).toBe(false)
			expect(isCodeLanguageId(codeLanguageForExtension(extension) ?? "")).toBe(true)
		}
	})

	it.each([
		["ts", "typescript"],
		["mts", "typescript"],
		["tsx", "tsx"],
		["jsx", "jsx"],
		["cjs", "javascript"],
		["h", "cpp"],
		["ino", "cpp"],
		["cs", "csharp"],
		["kts", "kotlin"],
		["gradle", "groovy"],
		["yml", "yaml"],
		["sass", "sass"],
		["scss", "scss"],
		["cql", "cql"],
		["pls", "plsql"],
		["svg", "xml"],
		["map", "json"],
		["r", "r"],
		["bzl", "python"],
		["tex", "latex"],
		["1", "troff"],
		["vue", "vue"],
		["svelte", "svelte"],
		["nix", "nix"],
		["solidity", "solidity"],
		["wat", "wast"]
	])("maps %s to %s as mobile does", (extension, language) => {
		expect(codeLanguageForExtension(extension)).toBe(language)
	})

	it.each([
		["html5", "html"],
		["css3", "css"],
		["litcoffee", "coffeescript"],
		["py3", "python"],
		["dockerfile", "dockerfile"],
		["cobol", "cobol"],
		["conf", "ini"],
		["protobuf", "protobuf"]
	])("keeps web's %s -> %s", (extension, language) => {
		expect(codeLanguageForExtension(extension)).toBe(language)
	})

	it("answers null for an unknown, an uppercase, a dotted or an inherited key", () => {
		for (const key of ["xyz123", "TS", ".ts", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
			expect(codeLanguageForExtension(key)).toBeNull()
		}

		expect(isCodeLanguageId("constructor")).toBe(false)
	})

	it("names every language", () => {
		for (const language of Object.values(CODE_LANGUAGES)) {
			expect(language.name.length).toBeGreaterThan(0)
		}
	})
})
