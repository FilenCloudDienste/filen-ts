import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { build } from "vite"

// The OCR worker builds into one module holding every engine build's glue (no request for code at run time) and
// naming the wasm and models by their hashed same-origin URLs.

describe("the OCR worker", () => {
	it("builds into one module with the engines' glue bundled", async () => {
		const result: unknown = await build({
			configFile: join(import.meta.dirname, "../../vite.config.ts"),
			logLevel: "silent",
			build: {
				write: false,
				minify: false,
				rolldownOptions: {
					input: join(import.meta.dirname, "../features/pdf/workers/ocr.worker.ts"),
					output: { format: "es", codeSplitting: false }
				}
			}
		})
		const outputs = (Array.isArray(result) ? result : [result]) as {
			readonly output: readonly { readonly type: string; readonly fileName: string; readonly code?: string }[]
		}[]
		const files = outputs.flatMap(output => output.output)
		const chunks = files.filter(file => file.type === "chunk")
		const code = chunks.map(chunk => chunk.code ?? "").join("\n")

		expect(chunks).toHaveLength(1)
		expect(code.match(/var TesseractCore\s*=/g)).toHaveLength(3)
		expect(code).toMatch(/\/assets\/ocr\/tesseract-core-simd-lstm-[0-9a-f]{8}\.wasm/)
		expect(code).toMatch(/\/assets\/ocr\/eng\.traineddata-[0-9a-f]{8}\.bin/)
		expect(code).not.toMatch(/import\s*\(/)
		expect(files.some(file => file.type === "asset" && /assets\/ocr\/tesseract-core-lstm-[0-9a-f]{8}\.wasm$/.test(file.fileName))).toBe(
			true
		)
	}, 600_000)
})
