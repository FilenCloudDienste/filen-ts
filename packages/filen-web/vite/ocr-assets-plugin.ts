import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Plugin } from "vite"
import { COI_HEADERS } from "./sdk-artifacts-plugin"
import { ensureTessdata, gzippedTessdata, readTessdataManifest, sha256, type TessdataFile } from "./ocr-tessdata"

// Text recognition for the PDF editor, served from 'self': tesseract.js-core's LSTM-only wasm builds (relaxed SIMD,
// SIMD and plain) and the tessdata_fast models (ocr-tessdata.ts), under /assets/ocr/ with the first 8 hex digits of
// their SHA-256 in the name (immutable). A build emits them; the dev server serves the same paths. Models are
// gzip-compressed and named .bin, not .gz (opaque bytes no host re-encodes); the OCR worker fetches only the
// languages picked, inflates and verifies them against the manifest's size and SHA-256.
//   virtual:ocr-assets   every URL, with each model's size, SHA-256 and download size (page and OCR worker);
//   virtual:ocr-engine/<build>  that build's Emscripten glue (a script defining `TesseractCore`), wrapped as a module
//                        exporting its factory; each build's OCR worker bundles its own (the worker's instance:
//                        ocrAssets({ emit: false })), so a browser loads only the glue of the build it runs.
// The licence texts ship in the third-party notices (scripts/generateThirdPartyNotices.ts), not as files.

const ASSETS_ID = "virtual:ocr-assets"
const ENGINE_PREFIX = "virtual:ocr-engine/"
const CORE_DIR = dirname(createRequire(import.meta.url).resolve("tesseract.js-core/package.json"))

// Best first: the worker picks the first its browser validates.
export const OCR_ENGINE_VARIANTS = ["relaxedsimd-lstm", "simd-lstm", "lstm"] as const

type Variant = (typeof OCR_ENGINE_VARIANTS)[number]

function isVariant(value: string): value is Variant {
	return (OCR_ENGINE_VARIANTS as readonly string[]).includes(value)
}

function glueSource(variant: Variant): string {
	const glue = readFileSync(join(CORE_DIR, `tesseract-core-${variant}.js`), "utf8")

	if (!glue.startsWith("var TesseractCore=")) throw new Error(`tesseract-core-${variant}.js no longer defines TesseractCore first`)

	return glue
}

function wasmSource(variant: Variant): Uint8Array {
	return readFileSync(join(CORE_DIR, `tesseract-core-${variant}.wasm`))
}

function wasmPath(variant: Variant, bytes: Uint8Array): string {
	return `assets/ocr/tesseract-core-${variant}-${sha256(bytes).slice(0, 8)}.wasm`
}

// The model file's path: its name, the hash of its uncompressed bytes, ".bin".
function modelPath(file: TessdataFile): string {
	return `assets/ocr/${file.file}-${file.sha256.slice(0, 8)}.bin`
}

export function ocrAssets(options: { readonly emit?: boolean } = {}): Plugin {
	const manifest = readTessdataManifest()
	const wasm = new Map(OCR_ENGINE_VARIANTS.map(variant => [variant, wasmPath(variant, wasmSource(variant))]))
	const models = new Map(manifest.languages.map(language => [modelPath(language), language]))
	const engines = new Map([...wasm].map(([variant, path]) => [path, variant]))
	let cache: Promise<string> | undefined
	let build = false

	// Downloads and verifies every pinned model the first time; afterwards a hash check of the cache.
	const ensureModels = (): Promise<string> => (cache ??= ensureTessdata(manifest))

	const assets = {
		engines: Object.fromEntries([...wasm].map(([variant, path]) => [variant, { wasm: `/${path}` }])),
		languages: Object.fromEntries(
			manifest.languages.map(language => [
				language.code,
				{ url: `/${modelPath(language)}`, bytes: language.bytes, sha256: language.sha256, transferBytes: language.gzipBytes }
			])
		)
	}

	const plugin: Plugin = {
		name: options.emit === false ? "filen:ocr-assets-modules" : "filen:ocr-assets",
		resolveId(id) {
			if (id === ASSETS_ID) return `\0${id}`

			return id.startsWith(ENGINE_PREFIX) && isVariant(id.slice(ENGINE_PREFIX.length)) ? `\0${id}` : null
		},
		load(id) {
			if (id === `\0${ASSETS_ID}`) return `export const OCR_ASSETS = Object.freeze(${JSON.stringify(assets)})\n`

			const variant = id.startsWith(`\0${ENGINE_PREFIX}`) ? id.slice(ENGINE_PREFIX.length + 1) : ""

			if (!isVariant(variant)) return null

			// The glue in a function scope of its own: its top-level `var`s stay local and it returns its factory.
			return `export const OCR_ENGINE_FACTORY = (() => {\n${glueSource(variant)}\nreturn TesseractCore\n})()\n`
		}
	}

	if (options.emit === false) return plugin

	return {
		...plugin,
		configResolved(config) {
			build = config.command === "build"
		},
		// A build fails early on a missing or altered model; the dev server and tests fetch them on first use.
		async buildStart() {
			if (build) await ensureModels()
		},
		// The preview serves the build's copies from dist/ instead, under the preview header set.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0]?.slice(1) ?? ""
				const variant = engines.get(path)
				const model = models.get(path)

				if (variant === undefined && model === undefined) {
					next()

					return
				}

				const send = (body: Uint8Array, type: string): void => {
					res.setHeader("Content-Type", type)
					res.setHeader("Content-Length", body.byteLength)

					for (const [name, value] of Object.entries(COI_HEADERS)) {
						res.setHeader(name, value)
					}

					res.end(body)
				}

				if (variant !== undefined) {
					send(wasmSource(variant), "application/wasm")

					return
				}

				if (model === undefined) return

				// Only the model asked for is fetched into the cache.
				ensureTessdata(manifest, [model.code])
					.then(dir => gzippedTessdata(dir, model))
					.then(
						body => {
							send(body, "application/octet-stream")
						},
						(error: unknown) => {
							server.config.logger.error(`ocr: ${error instanceof Error ? error.message : String(error)}`)
							res.statusCode = 500
							res.end()
						}
					)
			})
		},
		async generateBundle() {
			for (const [variant, path] of wasm) this.emitFile({ type: "asset", fileName: path, source: wasmSource(variant) })

			const dir = await ensureModels()

			// Compressed once per machine (in parallel on the thread pool: about 90 MB of models), then from the cache.
			await Promise.all(
				manifest.languages.map(async language => {
					const body = await gzippedTessdata(dir, language)

					if (body.byteLength !== language.gzipBytes) {
						this.warn(
							`${language.file}: gzip gives ${String(body.byteLength)} bytes, ocr-tessdata.json records ${String(language.gzipBytes)}`
						)
					}

					this.emitFile({ type: "asset", fileName: modelPath(language), source: body })
				})
			)
		}
	}
}
