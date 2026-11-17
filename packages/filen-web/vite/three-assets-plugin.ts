import { createReadStream, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, extname, join } from "node:path"
import type { Plugin } from "vite"
import { COI_HEADERS } from "./sdk-artifacts-plugin"

// The 3D viewer's decoders, served from 'self': Draco (compressed glTF geometry) and Basis Universal (KTX2 textures),
// the wasm builds three ships. Their loaders ask for them by directory URL plus file name, so they cannot be
// content-hashed one by one: the directory carries the pinned three version instead, and everything under /assets/ is
// cached as immutable. The development server serves the same paths. meshopt is inlined in its decoder module. The
// licence texts ship in the third-party notices.
//   virtual:three-assets   the base and each decoder directory (the 3D worker: threeAssets({ emit: false })).
const REQUIRE = createRequire(import.meta.url)
// three exports no package.json: its CommonJS build sits in build/ under the package root.
const THREE_DIR = dirname(dirname(REQUIRE.resolve("three")))
const LIBS_DIR = join(THREE_DIR, "examples/jsm/libs")
const VERSION = String((JSON.parse(readFileSync(join(THREE_DIR, "package.json"), "utf8")) as { version?: unknown }).version)

export const THREE_ASSETS_BASE = `/assets/three-${VERSION}/`

const VIRTUAL_ID = "virtual:three-assets"
const RESOLVED_ID = `\0${VIRTUAL_ID}`

// Paths under THREE_ASSETS_BASE, the same as under three's examples/jsm/libs: what DRACOLoader (its glTF build, wasm
// with the JS wrapper) and KTX2Loader fetch from a decoder path (src/tests/threeAssets.test.ts reads both loaders).
export const THREE_ASSET_FILES = [
	"draco/gltf/draco_wasm_wrapper.js",
	"draco/gltf/draco_decoder.wasm",
	"basis/basis_transcoder.js",
	"basis/basis_transcoder.wasm"
]

const MIME: Record<string, string> = {
	".wasm": "application/wasm",
	".js": "text/javascript; charset=utf-8"
}

export function threeAssets(options: { readonly emit?: boolean } = {}): Plugin {
	const served = new Set(THREE_ASSET_FILES)
	const urls = {
		base: THREE_ASSETS_BASE,
		draco: `${THREE_ASSETS_BASE}draco/gltf/`,
		basis: `${THREE_ASSETS_BASE}basis/`
	}
	const plugin: Plugin = {
		name: options.emit === false ? "filen:three-assets-modules" : "filen:three-assets",
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			return id === RESOLVED_ID ? `export const THREE_ASSETS = Object.freeze(${JSON.stringify(urls)})\n` : null
		}
	}

	if (options.emit === false) return plugin

	return {
		...plugin,
		// The preview serves the build's copies from dist/ instead, under the preview header set.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? ""
				const rel = path.startsWith(THREE_ASSETS_BASE) ? path.slice(THREE_ASSETS_BASE.length) : null

				if (rel === null || !served.has(rel)) {
					next()

					return
				}

				const file = join(LIBS_DIR, rel)

				res.setHeader("Content-Type", MIME[extname(rel)] ?? "application/octet-stream")
				res.setHeader("Content-Length", statSync(file).size)

				for (const [name, value] of Object.entries(COI_HEADERS)) {
					res.setHeader(name, value)
				}

				createReadStream(file)
					.on("error", () => {
						res.statusCode = 500
						res.end()
					})
					.pipe(res)
			})
		},
		generateBundle() {
			for (const file of THREE_ASSET_FILES) {
				this.emitFile({ type: "asset", fileName: THREE_ASSETS_BASE.slice(1) + file, source: readFileSync(join(LIBS_DIR, file)) })
			}
		}
	}
}
