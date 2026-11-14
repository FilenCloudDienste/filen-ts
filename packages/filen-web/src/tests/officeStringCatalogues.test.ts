import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { preview } from "@/locales/en/preview"

// The office editors' strings (locales/en/previewDocx/*, previewSheet/*, previewOffice/*) live in catalogues of their
// own, each spread into the preview namespace, and every key in them is one the app names.

const ROOT = process.cwd()
const CATALOGUES = ["previewDocx", "previewSheet", "previewOffice", "previewPdf"] as const

function sources(directory: string, into: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)

		if (entry.isDirectory()) {
			if (entry.name !== "locales" && entry.name !== "tests") sources(path, into)
		} else if (/\.tsx?$/.test(entry.name)) into.push(readFileSync(path, "utf8"))
	}

	return into
}

function catalogueFiles(name: (typeof CATALOGUES)[number]): string[] {
	return readdirSync(join(ROOT, "src/locales/en", name)).filter(file => file.endsWith(".ts"))
}

describe("the office editors' string catalogues", () => {
	it("are each registered in the preview namespace", () => {
		const source = readFileSync(join(ROOT, "src/locales/en/preview.ts"), "utf8")

		for (const name of CATALOGUES) {
			const files = catalogueFiles(name)

			expect(files.length, name).toBeGreaterThan(0)

			for (const file of files)
				expect(source, `${name}/${file}`).toContain(`from "@/locales/en/${name}/${file.replace(/\.ts$/, "")}"`)
		}
	})

	it("keep the editor's own strings in its catalogue, not in the viewer's preview.ts", () => {
		const source = readFileSync(join(ROOT, "src/locales/en/preview.ts"), "utf8")

		for (const key of [
			"previewDocxRibbonTabLayout",
			"previewDocxSaveRefused",
			"previewDocxCommandFailed",
			"previewDocxClipboardBlocked"
		]) {
			expect(source, key).not.toMatch(new RegExp(`^\\s+${key}:`, "m"))
			expect(preview).toHaveProperty(key)
		}
	})

	it.each([
		["previewDocx", "previewDocx"],
		["previewSheet", "previewSheet"],
		["previewPdf", "previewPdf"]
	] as const)("ship no %s string the app never names", (name, prefix) => {
		const code = sources(join(ROOT, "src")).join("\n")
		const directory = join(ROOT, "src/locales/en", name)
		const unused = catalogueFiles(name)
			.flatMap(file =>
				[
					...readFileSync(join(directory, file), "utf8").matchAll(
						new RegExp(`^\\t(${prefix}[A-Za-z0-9]+?)(?:_one|_other)?:`, "gm")
					)
				].map(match => match[1] ?? "")
			)
			.filter(key => !code.includes(key))

		expect(unused).toEqual([])
	})

	it("declare every PDF editor catalogue as const (the typed catalog checks each key's values)", () => {
		for (const file of catalogueFiles("previewPdf"))
			expect(readFileSync(join(ROOT, "src/locales/en/previewPdf", file), "utf8"), file).toMatch(/\n\} as const\n?$/)
	})

	it("give the PDF editor no sentence twice (one key per wording, shared where the meaning is one)", () => {
		const keys = new Map<string, string[]>()

		for (const file of catalogueFiles("previewPdf")) {
			const source = readFileSync(join(ROOT, "src/locales/en/previewPdf", file), "utf8")

			for (const match of source.matchAll(/^\t(previewPdf\w+):\s*("(?:[^"\\]|\\.)*")/gm)) {
				const text = match[2] ?? ""

				// Short button words ("Cancel", "Save", "Pages") stay per place, for their translators' context.
				if (text.split(/\s+/).length < 3) continue

				keys.set(text, [...(keys.get(text) ?? []), match[1] ?? ""])
			}
		}

		expect([...keys.values()].filter(names => names.length > 1)).toEqual([])
	})

	it("are imported into the app shell's logic (and the workers using it) for types only", () => {
		const source = readFileSync(join(ROOT, "src/features/shell/lib/appShell.logic.ts"), "utf8")

		expect(source).not.toMatch(/^import (?!type )[^\n]*from "@\/lib\/i18n"/m)
	})
})
