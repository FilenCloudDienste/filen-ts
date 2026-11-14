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
// What each heavy library leaves in unminified output whatever imports it: names its code defines.
const MARKERS: Readonly<Record<string, string>> = {
	mupdf: "_wasm_open_document_with_stream",
	"tesseract.js-core": "TessBaseAPI",
	pkijs: "CertificateChainValidationEngine",
	asn1js: "LocalBaseBlock",
	"node-forge": "pkcs12FromAsn1"
}
const WORKER_STUB = "\0pdf-engine-bundle-worker-stub"
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

// The source scans read every web and office source: slow on a loaded machine.
describe("the PDF engines stay out of the page bundle", { timeout: 60_000 }, () => {
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

	// The page as the app builds it, its workers stubbed (each is a bundle of its own, checked below and in
	// ocrWorkerBundle.test.ts): what remains is the page's code, which must hold none of the engines.
	it("builds the page without any of them", async () => {
		const result: unknown = await build({
			configFile: join(import.meta.dirname, "../../vite.config.ts"),
			logLevel: "silent",
			plugins: [
				{
					name: "stub-workers",
					enforce: "pre",
					resolveId: (id: string) => (/\?worker(&|$)/.test(id) ? WORKER_STUB : null),
					load: (id: string) => (id === WORKER_STUB ? "export default class {}" : null)
				}
			],
			build: { write: false, minify: false }
		})
		const outputs = (Array.isArray(result) ? result : [result]) as {
			readonly output: readonly { readonly type: string; readonly fileName: string; readonly code?: string }[]
		}[]
		const chunks = outputs.flatMap(output => output.output).filter(file => file.type === "chunk")
		const code = chunks.map(chunk => chunk.code ?? "").join("\n")

		expect(chunks.length).toBeGreaterThan(0)
		// The page's own code is in what was built (the viewer's pdf.js glue among it).
		expect(code).toContain("PDFDataRangeTransport")
		expect(Object.entries(MARKERS).filter(([, marker]) => code.includes(marker))).toEqual([])
	}, 600_000)

	// node-forge only for containers that need its legacy ciphers: the signer every signing starts is built without it.
	it("builds the certificate signer without node-forge, and the legacy signer with it", async () => {
		const workerCode = async (name: string): Promise<string> => {
			const result: unknown = await build({
				configFile: join(import.meta.dirname, "../../vite.config.ts"),
				logLevel: "silent",
				build: {
					write: false,
					minify: false,
					rolldownOptions: {
						input: join(import.meta.dirname, `../features/pdf/workers/${name}`),
						output: { format: "es", codeSplitting: false }
					}
				}
			})
			const outputs = (Array.isArray(result) ? result : [result]) as { readonly output: readonly { readonly code?: string }[] }[]

			return outputs
				.flatMap(output => output.output)
				.map(chunk => chunk.code ?? "")
				.join("\n")
		}
		const signer = await workerCode("pdfSigner.worker.ts")
		const legacy = await workerCode("pdfSignerLegacy.worker.ts")

		expect(signer).toContain(MARKERS["pkijs"])
		expect(signer).not.toContain(MARKERS["node-forge"])
		expect(legacy).toContain(MARKERS["node-forge"])
	}, 300_000)

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
