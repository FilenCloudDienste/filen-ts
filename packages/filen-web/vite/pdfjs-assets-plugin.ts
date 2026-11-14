import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, extname, join } from "node:path"
import type { Plugin } from "vite"
import { COI_HEADERS } from "./sdk-artifacts-plugin"

// pdf.js's own data files, served from 'self': the CJK character maps (non-embedded Asian fonts), the standard 14
// fonts (so documents lay out alike on every platform), the JPEG 2000 / JBIG2 / colour-management decoders with their
// no-wasm fallbacks, and the CMYK ICC profile, each directory with its licence files. pdf.js asks for them by
// directory URL plus file name, so they cannot be content-hashed one by one: the directory carries the pinned
// version instead, and everything under /assets/ is cached as immutable. The development server serves the same
// paths. The scripting engine (quickjs-eval) is never shipped: documents' scripts never run.
const REQUIRE = createRequire(import.meta.url)
const PDFJS_DIR = dirname(REQUIRE.resolve("pdfjs-dist/package.json"))
const VERSION = String((JSON.parse(readFileSync(join(PDFJS_DIR, "package.json"), "utf8")) as { version?: unknown }).version)

export const PDFJS_ASSETS_BASE = `/assets/pdfjs-${VERSION}/`

const VIRTUAL_ID = "virtual:pdfjs-assets"
const RESOLVED_ID = `\0${VIRTUAL_ID}`

// Every file shipped from each directory: what the pinned worker asks for (src/tests/pdfjsAssets.test.ts reads the
// worker to keep this complete) and the licences.
const WASM_FILES = ["openjpeg.wasm", "openjpeg_nowasm_fallback.js", "jbig2.wasm", "jbig2_nowasm_fallback.js", "qcms_bg.wasm"]
const ICC_FILES = ["CGATS001Compat-v2-micro.icc"]

function isLicence(name: string): boolean {
	return name.startsWith("LICENSE")
}

function listed(dir: string, keep: (name: string) => boolean): string[] {
	return readdirSync(join(PDFJS_DIR, dir))
		.filter(keep)
		.sort()
		.map(name => `${dir}/${name}`)
}

// Paths under PDFJS_ASSETS_BASE, the same as under pdfjs-dist.
export function pdfjsAssetFiles(): string[] {
	return [
		"LICENSE",
		...listed("cmaps", name => name.endsWith(".bcmap") || isLicence(name)),
		...listed("standard_fonts", name => name.endsWith(".pfb") || name.endsWith(".ttf") || isLicence(name)),
		...listed("wasm", name => WASM_FILES.includes(name) || isLicence(name)),
		...listed("iccs", name => ICC_FILES.includes(name) || isLicence(name))
	]
}

const MIME: Record<string, string> = {
	".wasm": "application/wasm",
	".js": "text/javascript; charset=utf-8",
	".ttf": "font/ttf"
}

// The licence files have no extension; everything else is opaque binary data (.bcmap, .pfb, .icc).
function mimeOf(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1)

	return isLicence(name) ? "text/plain; charset=utf-8" : (MIME[extname(name)] ?? "application/octet-stream")
}

export function pdfjsAssets(): Plugin {
	const files = pdfjsAssetFiles()
	// Exactly these files, so the dev middleware needs no path containment of its own.
	const served = new Set(files)
	const urls = {
		cMapUrl: `${PDFJS_ASSETS_BASE}cmaps/`,
		standardFontDataUrl: `${PDFJS_ASSETS_BASE}standard_fonts/`,
		wasmUrl: `${PDFJS_ASSETS_BASE}wasm/`,
		iccUrl: `${PDFJS_ASSETS_BASE}iccs/`
	}

	return {
		name: "filen:pdfjs-assets",
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			return id === RESOLVED_ID ? `export const PDFJS_ASSETS = Object.freeze(${JSON.stringify(urls)})\n` : null
		},
		// The preview serves the build's copies from dist/ instead, under the preview header set.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? ""
				const rel = path.startsWith(PDFJS_ASSETS_BASE) ? path.slice(PDFJS_ASSETS_BASE.length) : null

				if (rel === null || !served.has(rel)) {
					next()

					return
				}

				const file = join(PDFJS_DIR, rel)

				res.setHeader("Content-Type", mimeOf(rel))
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
			for (const file of files) {
				this.emitFile({ type: "asset", fileName: PDFJS_ASSETS_BASE.slice(1) + file, source: readFileSync(join(PDFJS_DIR, file)) })
			}
		}
	}
}
