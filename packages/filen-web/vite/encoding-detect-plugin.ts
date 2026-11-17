import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Plugin } from "vite"
import { WASM_PATH, buildWasm } from "@filen/encoding-detect/build-wasm"
import { COI_HEADERS } from "./sdk-artifacts-plugin"

// @filen/encoding-detect's wasm module (chardetng), served from 'self'. Built from source (cargo, incremental) at build
// start, and on the dev server's first request for it; a build emits it under /assets/encoding-detect/ with the first 8
// hex digits of its SHA-256 in the name (immutable). `virtual:encoding-detect` gives the page its URL.
const DEV_URL = "/encoding-detect/filen_encoding_detect.wasm"
const VIRTUAL_ID = "virtual:encoding-detect"
const RESOLVED_ID = `\0${VIRTUAL_ID}`

export function encodingDetectAsset(): Plugin {
	let build = false
	let wasmUrl = DEV_URL
	let wasm: Promise<unknown> | undefined
	// A dev server and the test runner only build the module when a page first asks for it.
	const ensureWasm = (): Promise<unknown> => (wasm ??= buildWasm())

	return {
		name: "filen:encoding-detect",
		configResolved(config) {
			build = config.command === "build"
		},
		async buildStart() {
			if (!build) {
				return
			}

			await ensureWasm()
			wasmUrl = `/assets/encoding-detect/filen_encoding_detect-${createHash("sha256").update(readFileSync(WASM_PATH)).digest("hex").slice(0, 8)}.wasm`
		},
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			return id === RESOLVED_ID ? `export const ENCODING_DETECT_WASM = ${JSON.stringify(wasmUrl)}\n` : null
		},
		// The preview serves the build's copy from dist/ instead, under the preview header set.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				if ((req.url ?? "").split("?")[0] !== DEV_URL) {
					next()

					return
				}

				ensureWasm().then(
					() => {
						const body = readFileSync(WASM_PATH)

						res.setHeader("Content-Type", "application/wasm")
						res.setHeader("Content-Length", body.byteLength)

						for (const [name, value] of Object.entries(COI_HEADERS)) {
							res.setHeader(name, value)
						}

						res.end(body)
					},
					(error: unknown) => {
						server.config.logger.error(`encoding-detect: ${error instanceof Error ? error.message : String(error)}`)
						res.statusCode = 500
						res.end()
					}
				)
			})
		},
		generateBundle() {
			this.emitFile({ type: "asset", fileName: wasmUrl.slice(1), source: readFileSync(WASM_PATH) })
		}
	}
}
