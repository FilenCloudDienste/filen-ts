import { cpSync, createReadStream, existsSync } from "node:fs"
import { extname, join, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import type { Plugin, ResolvedConfig } from "vite"

const require = createRequire(import.meta.url)
// NOTE: `@filen/sdk-rs`'s package.json `exports` map does not list "./package.json",
// so `require.resolve("@filen/sdk-rs/package.json")` throws (verified against the
// installed 0.4.29 exports map). Resolve the package root via its "." export (main
// entry, "./sdk-rs.js") instead — robust to node_modules layout, no import.meta.dirname
// guessing, and doesn't depend on an unexported subpath.
const PKG = join(require.resolve("@filen/sdk-rs"), "..")
// B1 deployment contract: the SDK wasm holds a RELATIVE `./filen-sdk-worker-thread.js` (verified via
// `strings` over sdk-rs_bg.wasm) which it hands to `new Worker(...)`. So the async-runtime thread
// worker — and its transitive `sdk-rs.js` / `snippets/**` / `sdk-rs_bg.wasm` loads — resolve against
// the SPAWNING worker's own `self.location` directory, and so does this worker's own explicit wasm
// `init` URL. That directory is env-specific (T3 S1, verified live in dev + preview): `/src/workers/`
// in dev (Vite serves the worker from its source path), `/assets/` in the build (Vite emits the
// worker chunk there). There is therefore NO single fixed base — dev must serve these files at
// WHATEVER directory the request carries (match by basename / `/snippets/` suffix), and the build
// copies them next to the emitted worker in `<assetsDir>`.
const ARTIFACTS = ["filen-sdk-worker-thread.js", "sdk-rs.js", "sdk-rs_bg.wasm"]
const MIME: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" }
const COI: Record<string, string> = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin"
}

// Map a request path to the package-relative artifact it serves, or null — directory-agnostic so it
// works both at the worker's dev source dir and at the built assets dir. `sdk.worker.ts` and Vite's
// own hashed emits never collide (the names here are exact and unhashed).
function artifactRel(urlPath: string): string | null {
	const snippetIdx = urlPath.indexOf("/snippets/")
	if (snippetIdx !== -1) {
		return urlPath.slice(snippetIdx + 1) // "snippets/…" relative to PKG
	}
	const base = urlPath.slice(urlPath.lastIndexOf("/") + 1)
	return ARTIFACTS.includes(base) ? base : null
}

export function sdkArtifacts(): Plugin {
	let config: ResolvedConfig
	return {
		name: "filen:sdk-artifacts",
		configResolved(c) {
			config = c
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = (req.url ?? "").split("?")[0] ?? ""
				const rel = artifactRel(url)
				if (rel === null) {
					next()
					return
				}
				// Containment: the `/snippets/…` branch carries a request-controlled path — never let it
				// escape PKG via `..` (dev-only traversal hardening; the T2 review flagged the raw join).
				const file = resolve(PKG, rel)
				if (file !== PKG && !file.startsWith(PKG + sep)) {
					next()
					return
				}
				if (!existsSync(file)) {
					next()
					return
				}
				res.setHeader("Content-Type", MIME[extname(file)] ?? "text/javascript")
				for (const [k, v] of Object.entries(COI)) {
					res.setHeader(k, v)
				}
				createReadStream(file)
					.on("error", () => {
						res.statusCode = 500
						res.end()
					})
					.pipe(res)
			})
		},
		closeBundle() {
			// Prod worker resolves against `<assetsDir>` (T3 S1) — copy the artifacts + snippets there.
			const out = join(config.root, config.build.outDir, config.build.assetsDir)
			for (const a of ARTIFACTS) {
				cpSync(join(PKG, a), join(out, a))
			}
			cpSync(join(PKG, "snippets"), join(out, "snippets"), { recursive: true })
		}
	}
}
