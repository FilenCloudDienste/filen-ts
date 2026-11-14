import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"

// Every data file the pinned pdf.js worker can ask for is shipped, and its scripting engine never is.

const { PDFJS_ASSETS_BASE, pdfjsAssetFiles, pdfjsAssets } = await import("../../vite/pdfjs-assets-plugin")

const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"))
const WORKER = readFileSync(join(PDFJS_DIR, "build/pdf.worker.mjs"), "utf8")

function matches(pattern: RegExp): string[] {
	return [...WORKER.matchAll(pattern)].map(match => match[1] ?? "")
}

describe("pdf.js assets", () => {
	const files = new Set(pdfjsAssetFiles())

	it("ship every decoder and fallback the worker loads", () => {
		const decoders = [...matches(/_filename = "([^"]+)"/g), ...matches(/_noWasmFilename = "([^"]+)"/g)]

		expect(decoders.length).toBeGreaterThanOrEqual(4)

		for (const name of decoders) expect(files).toContain(`wasm/${name}`)

		for (const name of matches(/\$\{this\.#wasmUrl\}([\w.-]+)`/g)) expect(files).toContain(`wasm/${name}`)
	})

	it("ship the ICC profile and every standard font the worker maps a base font to", () => {
		for (const name of matches(/#iccUrl\}([\w.-]+\.icc)`/g)) expect(files).toContain(`iccs/${name}`)

		const fonts = new Set(matches(/"([\w-]+\.(?:pfb|ttf))"/g))

		expect(fonts.size).toBeGreaterThanOrEqual(10)

		for (const name of fonts) expect(files).toContain(`standard_fonts/${name}`)
	})

	it("ship every packed character map and every licence", () => {
		for (const name of readdirSync(join(PDFJS_DIR, "cmaps"))) expect(files).toContain(`cmaps/${name}`)

		for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
			for (const name of readdirSync(join(PDFJS_DIR, dir)).filter(entry => entry.startsWith("LICENSE"))) {
				expect(files).toContain(`${dir}/${name}`)
			}
		}

		expect(files).toContain("LICENSE")
	})

	it("never ship the scripting engine", () => {
		expect([...files].filter(file => file.includes("quickjs"))).toEqual([])
	})

	it("serve each directory under the versioned base", async () => {
		const plugin = pdfjsAssets()
		const load = plugin.load

		expect(typeof load).toBe("function")

		if (typeof load !== "function") return

		const resolved = "\0virtual:pdfjs-assets"
		const source: unknown = await Reflect.apply(load, {}, [resolved])

		expect(PDFJS_ASSETS_BASE).toMatch(/^\/assets\/pdfjs-\d+\.\d+\.\d+\/$/)
		expect(String(source)).toContain(`"cMapUrl":"${PDFJS_ASSETS_BASE}cmaps/"`)
		expect(String(source)).toContain(`"wasmUrl":"${PDFJS_ASSETS_BASE}wasm/"`)
		expect(String(source)).toContain(`"iccUrl":"${PDFJS_ASSETS_BASE}iccs/"`)
		expect(String(source)).toContain(`"standardFontDataUrl":"${PDFJS_ASSETS_BASE}standard_fonts/"`)
	})
})
