import { vi, describe, it, expect } from "vitest"

// Mock the langs module so langs['ts']() can be tested without a real CodeMirror setup.
vi.mock("@uiw/codemirror-extensions-langs", () => {
	const langNames: string[] = ["ts", "tsx", "js", "jsx", "json", "python", "rust", "css", "html", "sql"]

	const mockLangSupport = { language: {}, support: {}, extension: {} }
	const langs: Record<string, () => typeof mockLangSupport> = {}

	for (const name of langNames) {
		langs[name] = () => mockLangSupport
	}

	return {
		langs,
		langNames,
		loadLanguage: vi.fn()
	}
})

vi.mock("@uiw/codemirror-themes", () => ({
	createTheme: vi.fn(() => ({}))
}))

vi.mock("@lezer/highlight", () => ({
	tags: new Proxy(
		{},
		{
			get(_target, prop) {
				// Tag modifiers are called with a tag
				if (prop === "special" || prop === "definition") return (tag: unknown) => tag
				return {}
			}
		}
	)
}))

import { createTheme } from "@uiw/codemirror-themes"
import { parseExtension, loadLanguage, createTextTheme } from "@/components/textEditor/codeMirror"

describe("parseExtension", () => {
	it("returns empty string for a string with no dot", () => {
		expect(parseExtension("README")).toBe("")
	})

	it("returns empty string for 'Makefile' (no dot)", () => {
		expect(parseExtension("Makefile")).toBe("")
	})

	it("returns '.ts' for 'foo.ts'", () => {
		expect(parseExtension("foo.ts")).toBe(".ts")
	})

	it("returns '.tsx' for 'Component.tsx'", () => {
		expect(parseExtension("Component.tsx")).toBe(".tsx")
	})

	it("returns the last extension only for multi-dot names: 'archive.tar.gz' -> '.gz'", () => {
		expect(parseExtension("archive.tar.gz")).toBe(".gz")
	})

	it("normalizes to lowercase: 'FOO.TS' -> '.ts'", () => {
		expect(parseExtension("FOO.TS")).toBe(".ts")
	})

	it("trims surrounding whitespace before splitting: '  foo.js  ' -> '.js'", () => {
		expect(parseExtension("  foo.js  ")).toBe(".js")
	})

	it("returns empty string for an empty string", () => {
		expect(parseExtension("")).toBe("")
	})

	it("returns '.' for a bare dot '.' (no language matches it)", () => {
		expect(parseExtension(".")).toBe(".")
	})

	it("handles path separators in the string: 'path/to/file.ts' -> '.ts'", () => {
		// The function does not strip path separators, but '.' is present so it
		// splits on dot: ['path/to/file', 'ts'] -> lastPart = 'ts' -> '.ts'
		expect(parseExtension("path/to/file.ts")).toBe(".ts")
	})

	it("handles deeply nested multi-dot path: 'a/b.c.d.e' -> '.e'", () => {
		expect(parseExtension("a/b.c.d.e")).toBe(".e")
	})
})

describe("loadLanguage", () => {
	it("returns null for a filename with no extension", () => {
		expect(loadLanguage("README")).toBeNull()
	})

	it("returns null for an extension not in langNames (e.g. '.unknownxyz123')", () => {
		expect(loadLanguage("file.unknownxyz123")).toBeNull()
	})

	it("returns an object with language/support/extension fields for a known extension '.ts'", () => {
		const result = loadLanguage("index.ts")

		expect(result).not.toBeNull()
		expect(result).toHaveProperty("language")
		expect(result).toHaveProperty("support")
		expect(result).toHaveProperty("extension")
	})

	it("delegates to parseExtension: works when passed a full filename 'index.ts'", () => {
		const byFilename = loadLanguage("index.ts")
		const byExt = loadLanguage(".ts")

		// Both should produce a truthy result (langNames contains 'ts')
		expect(byFilename).not.toBeNull()
		expect(byExt).not.toBeNull()
	})

	it("returns a truthy object for '.tsx'", () => {
		expect(loadLanguage("Component.tsx")).not.toBeNull()
	})

	it("returns null for a filename with no dot (parseExtension returns empty string)", () => {
		// 'file' has no dot -> parseExtension returns '' -> not in langNames -> returns null
		expect(loadLanguage("file")).toBeNull()
	})

	it("returns null for empty string input", () => {
		expect(loadLanguage("")).toBeNull()
	})
})

describe("createTextTheme", () => {
	it("builds only the selected platform/mode theme", () => {
		vi.mocked(createTheme).mockClear()

		createTextTheme({ platform: "ios", darkMode: true, backgroundColor: "#000", textForegroundColor: "#fff" })

		expect(createTheme).toHaveBeenCalledTimes(1)
		expect(vi.mocked(createTheme).mock.calls[0]?.[0]).toMatchObject({
			theme: "dark",
			settings: { background: "#000", foreground: "#fff", selection: "#0A84FF40", gutterBorder: "1px solid #3A3A3C" }
		})
	})

	it("uses the GNOME palette off iOS", () => {
		vi.mocked(createTheme).mockClear()

		createTextTheme({ platform: "android", darkMode: false, backgroundColor: "#fff", textForegroundColor: "#000" })

		expect(vi.mocked(createTheme).mock.calls[0]?.[0]).toMatchObject({
			theme: "light",
			settings: { selection: "#3584E440", gutterBackground: "#FAFAFA", gutterForeground: "#77767B" }
		})
	})
})
