import { cpSync, createReadStream, existsSync } from "node:fs"
import { extname, join } from "node:path"
import { createRequire } from "node:module"
import type { Plugin, ResolvedConfig } from "vite"

const require = createRequire(import.meta.url)
// NOTE: `@filen/sdk-rs`'s package.json `exports` map does not list "./package.json",
// so `require.resolve("@filen/sdk-rs/package.json")` throws (verified against the
// installed 0.4.29 exports map). Resolve the package root via its "." export (main
// entry, "./sdk-rs.js") instead — robust to node_modules layout, no import.meta.dirname
// guessing, and doesn't depend on an unexported subpath.
const PKG = join(require.resolve("@filen/sdk-rs"), "..")
// B1 deployment contract: the wasm spawns new Worker("./filen-sdk-worker-thread.js") against
// the spawn base; these files must be reachable there (spike root-cause section).
const ARTIFACTS = ["filen-sdk-worker-thread.js", "sdk-rs.js", "sdk-rs_bg.wasm"]
const MIME: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" }
const COI: Record<string, string> = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin"
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
				// TODO(T3-S1): serving under both `/` and `/assets/` is a placement hedge until
				// the real sdk-rs.js spawn base is confirmed — delete this rewrite (and the
				// matching closeBundle copy-to-both-dirs loop below) once T3 S1 settles it.
				const stripped = url.replace(/^\/assets\//, "/")
				const rel = ARTIFACTS.find(a => stripped === `/${a}`) ?? (stripped.startsWith("/snippets/") ? stripped.slice(1) : undefined)
				if (rel === undefined) {
					next()
					return
				}
				const file = join(PKG, rel)
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
			const out = join(config.root, config.build.outDir)
			for (const dest of [out, join(out, "assets")]) {
				for (const a of ARTIFACTS) {
					cpSync(join(PKG, a), join(dest, a))
				}
				cpSync(join(PKG, "snippets"), join(dest, "snippets"), { recursive: true })
			}
		}
	}
}
