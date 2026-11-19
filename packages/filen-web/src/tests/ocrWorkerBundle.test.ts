import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { bundleCode, workerBuild } from "@/tests/fixtures/bundleBuild"

// Each engine build's OCR worker builds into one module holding that build's glue alone (no request for code at run
// time) and naming the wasm and models by their hashed same-origin URLs. Each build's glue names its own wasm file
// (`tesseract-core-<build>.wasm`) and no other, which ties a worker to the build whose glue it bundled; the hashed URLs
// of OCR_ASSETS (`tesseract-core-<build>-<hash>.wasm`) never match that name. Those URLs carry the hash of the wasm
// tesseract.js-core ships, which is what a build emits under them.

const { OCR_ENGINE_VARIANTS } = await import("../../vite/ocr-assets-plugin")

const CORE_DIR = dirname(createRequire(import.meta.url).resolve("tesseract.js-core/package.json"))
const WASM_URLS = OCR_ENGINE_VARIANTS.map(
	variant =>
		`/assets/ocr/tesseract-core-${variant}-${createHash("sha256")
			.update(readFileSync(join(CORE_DIR, `tesseract-core-${variant}.wasm`)))
			.digest("hex")
			.slice(0, 8)}.wasm`
)

const WORKERS = [
	["ocrRelaxedSimd.worker.ts", "relaxedsimd-lstm"],
	["ocrSimd.worker.ts", "simd-lstm"],
	["ocrPlain.worker.ts", "lstm"]
]

describe("the OCR workers", () => {
	it.each(WORKERS)(
		"%s builds into one module with the %s build's glue bundled",
		async (worker, variant) => {
			const files = await workerBuild(worker)
			const chunks = files.filter(file => file.type === "chunk")
			const code = bundleCode(files)

			expect(chunks).toHaveLength(1)
			expect(code.match(/var TesseractCore\s*=/g)).toHaveLength(1)

			for (const url of WASM_URLS) expect(code).toContain(url)

			expect(code).toMatch(/\/assets\/ocr\/eng\.traineddata-[0-9a-f]{8}\.bin/)
			expect(code).not.toMatch(/import\s*\(/)

			for (const other of OCR_ENGINE_VARIANTS) {
				expect(code.includes(`tesseract-core-${other}.wasm`)).toBe(other === variant)
			}
		},
		600_000
	)
})
