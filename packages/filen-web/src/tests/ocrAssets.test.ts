import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { SUPPORTED_LANGUAGES } from "@filen/shared/languages"
import { OCR_ENGINE_VARIANTS as OFFICE_VARIANTS } from "@filen/office/dom/pdfedit/ocr"
import { OCR_LANGUAGES, OCR_LANGUAGE_OF_UI, defaultOcrLanguages } from "@/features/pdf/ocr/languages"

// The text recognition assets: every language the app offers is pinned and served, the engine builds the worker
// picks from exist, and the virtual module names them under hashed URLs in a build.

const { OCR_ENGINE_VARIANTS, ocrAssets } = await import("../../vite/ocr-assets-plugin")
const { readTessdataManifest } = await import("../../vite/ocr-tessdata")

const CORE_DIR = dirname(createRequire(import.meta.url).resolve("tesseract.js-core/package.json"))

async function loaded(id: string, emit = true): Promise<string> {
	const load = ocrAssets({ emit }).load

	if (typeof load !== "function") throw new Error("plugin load hook missing")

	return String(await Reflect.apply(load, {}, [`\0${id}`]))
}

async function served(): Promise<unknown> {
	const source = await loaded("virtual:ocr-assets")
	const json = /^export const OCR_ASSETS = Object\.freeze\((.*)\)\n$/s.exec(source)?.[1]

	if (json === undefined) throw new Error(`unexpected module: ${source.slice(0, 80)}`)

	return JSON.parse(json)
}

describe("OCR assets", () => {
	const manifest = readTessdataManifest()

	it("pins exactly the languages the app offers, every UI language's among them", () => {
		expect(manifest.languages.map(language => language.code)).toEqual([...OCR_LANGUAGES])

		for (const ui of SUPPORTED_LANGUAGES) expect(OCR_LANGUAGES).toContain(OCR_LANGUAGE_OF_UI[ui])

		for (const extra of ["chi_sim", "chi_tra", "jpn", "kor", "ara", "heb", "hin", "rus"]) expect(OCR_LANGUAGES).toContain(extra)

		expect(defaultOcrLanguages("de")).toEqual(["deu", "eng"])
		expect(defaultOcrLanguages("en")).toEqual(["eng"])
	})

	it("pins one upstream commit with a size, hash and download size per model", () => {
		expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/)
		expect(manifest.repository).toBe("https://github.com/tesseract-ocr/tessdata_fast")

		for (const language of manifest.languages) {
			expect(language.file).toBe(`${language.code}.traineddata`)
			expect(language.sha256).toMatch(/^[0-9a-f]{64}$/)
			expect(language.gzipBytes).toBeGreaterThan(0)
			expect(language.gzipBytes).toBeLessThan(language.bytes)
		}
	})

	it("offers the engine builds the worker picks from, best first", () => {
		expect([...OCR_ENGINE_VARIANTS]).toEqual([...OFFICE_VARIANTS])

		for (const variant of OCR_ENGINE_VARIANTS) {
			expect(existsSync(join(CORE_DIR, `tesseract-core-${variant}.wasm`))).toBe(true)
			expect(readFileSync(join(CORE_DIR, `tesseract-core-${variant}.js`), "utf8").startsWith("var TesseractCore=")).toBe(true)
		}
	})

	it("names hashed URLs under /assets/ocr/", async () => {
		const assets = await served()
		const engines = Object.fromEntries(
			OCR_ENGINE_VARIANTS.map(variant => [
				variant,
				{ wasm: expect.stringMatching(new RegExp(`^/assets/ocr/tesseract-core-${variant}-[0-9a-f]{8}\\.wasm$`)) as unknown }
			])
		)
		const languages = Object.fromEntries(
			manifest.languages.map(language => [
				language.code,
				{
					url: `/assets/ocr/${language.code}.traineddata-${language.sha256.slice(0, 8)}.bin`,
					bytes: language.bytes,
					sha256: language.sha256,
					transferBytes: language.gzipBytes
				}
			])
		)

		expect(assets).toEqual({ engines, languages })
	})

	it("bundles each build's glue as a factory, in the worker's own instance too", async () => {
		const source = await loaded("virtual:ocr-engines", false)

		for (const variant of OCR_ENGINE_VARIANTS) expect(source).toContain(`"${variant}": (() => {\nvar TesseractCore=`)

		expect(source.match(/\nreturn TesseractCore\n\}\)\(\)/g)).toHaveLength(3)
	})
})
