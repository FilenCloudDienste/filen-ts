import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { build } from "vite"

// The PDF editor's heavy engines (MuPDF's wasm glue, Tesseract, the PKCS#12 and CMS libraries) live in their workers,
// never in the page's single bundle: only a worker module imports them by value, and @filen/office only by type (the
// host passes the module in), except its signature verifier (core/pdfsign, which parses CMS with pkijs), whose entries
// only a worker imports by value. The engine worker builds into one file that holds MuPDF, with the wasm emitted as a
// hashed asset beside it.

const HEAVY = ["mupdf", "tesseract.js-core", "pkijs", "node-forge", "asn1js"]
// @filen/office's verifier: pkijs and asn1js by value, so for workers only. Its summary entry is dependency-free.
const VERIFIER = [
	"@filen/office/core/pdfsign",
	"@filen/office/dom/pdfedit/verify",
	"@filen/office/dom/pdfedit/verifyRequest",
	"@filen/office/dom/pdfedit/digest"
]
const VERIFIER_LIBRARIES = new Set(["pkijs", "asn1js"])
const WEB_SRC = join(import.meta.dirname, "..")
const OFFICE_SRC = join(import.meta.dirname, "../../../filen-office/src")

function sources(root: string): string[] {
	return readdirSync(root, { recursive: true, encoding: "utf8" })
		.filter(path => /\.tsx?$/.test(path) && !/(^|\/)(tests|scripts|bench)\//.test(path))
		.map(path => join(root, path))
}

// Imports of `specifier` (or its subpaths) that bring values, not only types; a statement never runs past its own `from`.
function valueImports(code: string, specifier: string): number {
	const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const pattern = new RegExp(
		`^\\s*(import|export)\\s+(?!type\\b)(?:(?!\\bfrom\\s+["'])[\\s\\S])*?\\bfrom\\s+["']${escaped}(/[^"']*)?["']|import\\(\\s*["']${escaped}(/[^"']*)?["']`,
		"gm"
	)

	return [...code.matchAll(pattern)].length
}

// Value imports of the verifier's dependency-free summary entry, which `valueImports` counts as its subpath.
function exactSummaryImports(code: string, specifier: string): number {
	return specifier === "@filen/office/core/pdfsign" ? valueImports(code, "@filen/office/core/pdfsign/summary") : 0
}

describe("the PDF engines stay out of the page bundle", () => {
	it("imports them by value only from worker modules", () => {
		const offenders = sources(WEB_SRC).flatMap(path => {
			const code = readFileSync(path, "utf8")

			return [...HEAVY, ...VERIFIER]
				.filter(specifier => valueImports(code, specifier) > exactSummaryImports(code, specifier) && !path.includes("/workers/"))
				.map(specifier => `${relative(WEB_SRC, path)} imports ${specifier}`)
		})

		expect(offenders).toEqual([])
	})

	it("has @filen/office import them by type only", () => {
		const offenders = sources(OFFICE_SRC).flatMap(path => {
			const code = readFileSync(path, "utf8")

			const verifier = relative(OFFICE_SRC, path).startsWith("core/pdfsign/")

			return HEAVY.filter(specifier => valueImports(code, specifier) > 0 && !(verifier && VERIFIER_LIBRARIES.has(specifier))).map(
				specifier => `${relative(OFFICE_SRC, path)} imports ${specifier}`
			)
		})

		expect(offenders).toEqual([])
	})

	it("builds the engine worker into one module with MuPDF and its wasm as an asset", async () => {
		const result: unknown = await build({
			configFile: join(import.meta.dirname, "../../vite.config.ts"),
			logLevel: "silent",
			build: {
				write: false,
				minify: false,
				rolldownOptions: {
					input: join(import.meta.dirname, "../features/pdf/workers/pdfEngine.worker.ts"),
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
		expect(code).toContain("$libmupdf_wasm_Module")
		expect(code).toContain("_wasm_open_document_with_stream")
		// Node's branches stay unreachable stubs: nothing imports a node: module at run time.
		expect(code).not.toMatch(/import\s*\(\s*["']node:/)
		expect(files.some(file => file.type === "asset" && /mupdf-wasm-[\w-]+\.wasm$/.test(file.fileName))).toBe(true)
	}, 180_000)
})
