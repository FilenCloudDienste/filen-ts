import { cpSync, createReadStream, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { dirname, extname, join, resolve, sep } from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import type { Plugin, ResolvedConfig } from "vite"

const require = createRequire(import.meta.url)
// The package is located through its node_modules LINK, whose target is re-read on every use:
// require.resolve follows pnpm's symlink to the versioned store directory, which outlives a version bump,
// so a dev server started before `pnpm install` kept serving the old wasm next to the new glue Vite picked
// up (a LinkError on boot). The "." export is the fallback because the package's `exports` map does not
// list "./package.json", so `require.resolve("@filen/sdk-rs/package.json")` throws.
const PKG_LINK = findPackageLink(join(require.resolve("@filen/sdk-rs"), ".."))

// The same lookup Node does from this file: the closest ancestor node_modules holding the package.
function findPackageLink(resolved: string): string {
	for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
		const link = join(dir, "node_modules", "@filen", "sdk-rs")

		if (existsSync(link)) {
			return link
		}

		if (dirname(dir) === dir) {
			return resolved
		}
	}
}

function packageRoot(): string {
	return realpathSync.native(PKG_LINK)
}

// Deployment contract: the SDK wasm holds a RELATIVE `./filen-sdk-worker-thread.js` (verified via
// `strings` over sdk-rs_bg.wasm) which it hands to `new Worker(...)`. So the async-runtime thread
// worker — and its transitive `sdk-rs.js` / `snippets/**` / `sdk-rs_bg.wasm` loads — resolve against
// the SPAWNING worker's own `self.location` directory, and so does this worker's own explicit wasm
// `init` URL. That directory is env-specific (verified live in dev + preview): `/src/workers/`
// in dev (Vite serves the worker from its source path), `/assets/` in the build (Vite emits the
// worker chunk there). There is therefore NO single fixed base — dev must serve these files at
// WHATEVER directory the request carries (match by basename / `/snippets/` suffix), and the build
// copies them next to the emitted worker in `<assetsDir>`.
// The rayon pool workers are NOT part of that copy: the snippet's own
// `new Worker(new URL("./workerHelpers.js", import.meta.url))` is Vite's to emit. Since 8.3.0 Vite drops a
// worker entry whose referencing module was tree-shaken out of the PAGE bundle, without checking whether another
// worker still references it, so a page-side value import of @filen/sdk-rs (or of the sdk worker) loses the
// hashed `workerHelpers-*.js`; the SPA fallback then answers those worker loads with index.html and boot fails
// with reason "pool" while every check stays green. closeBundle below fails the build instead.
export const SDK_ARTIFACTS = ["filen-sdk-worker-thread.js", "sdk-rs.js", "sdk-rs_bg.wasm"]
const MIME: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm" }
export const COI_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin"
} as const

// Map a request path to the package-relative artifact it serves, or null — directory-agnostic so it
// works both at the worker's dev source dir and at the built assets dir. `sdk.worker.ts` and Vite's
// own hashed emits never collide (the names here are exact and unhashed).
function artifactRel(urlPath: string): string | null {
	// A request that already names a path INSIDE the package is authoritative — Vite can serve it from
	// where it actually lives, and this middleware must not answer it from the package root instead.
	// Two of these basenames are not unique: the package ships a separate single-threaded build for the
	// service worker under service-worker/, with its own sdk-rs.js and its own (much smaller)
	// sdk-rs_bg.wasm. Matching those by basename handed the worker the PAGE's threaded binary, which
	// fails to instantiate against single-threaded glue because it imports its memory.
	if (urlPath.includes("/@filen/sdk-rs/")) {
		return null
	}

	const snippetIdx = urlPath.indexOf("/snippets/")
	if (snippetIdx !== -1) {
		return urlPath.slice(snippetIdx + 1) // "snippets/…" relative to the package root
	}
	const base = urlPath.slice(urlPath.lastIndexOf("/") + 1)
	return SDK_ARTIFACTS.includes(base) ? base : null
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
				// escape the package via `..` (dev-only traversal hardening).
				const pkg = packageRoot()
				const file = resolve(pkg, rel)
				if (file !== pkg && !file.startsWith(pkg + sep)) {
					next()
					return
				}
				if (!existsSync(file)) {
					next()
					return
				}
				res.setHeader("Content-Type", MIME[extname(file)] ?? "text/javascript")
				for (const [k, v] of Object.entries(COI_HEADERS)) {
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
			// A dev server runs this hook too, when it closes or restarts on a config change, and would then
			// rewrite an existing build's dist/, deleting the service worker's own hashed wasm below.
			if (config.command !== "build") {
				return
			}

			// Prod worker resolves against `<assetsDir>` — copy the artifacts + snippets there.
			// resolve, not join: an absolute outDir must not land inside the root.
			const out = resolve(config.root, config.build.outDir, config.build.assetsDir)
			const pkg = packageRoot()
			for (const a of SDK_ARTIFACTS) {
				cpSync(join(pkg, a), join(out, a))
			}
			cpSync(join(pkg, "snippets"), join(out, "snippets"), { recursive: true })
			// Vite also emits a CONTENT-HASHED wasm copy from the glue's dead default-arg branch
			// (`new URL("sdk-rs_bg.wasm", import.meta.url)`), which the worker's explicit `init({ module_or_path })`
			// never takes — a byte-identical ~10 MB duplicate that is never fetched. Drop it so exactly one
			// `sdk-rs_bg.wasm` (the unhashed contract copy above) ships.
			for (const f of readdirSync(out)) {
				if (f.startsWith("sdk-rs_bg-") && f.endsWith(".wasm")) {
					rmSync(join(out, f))
				}
			}

			assertReferencedAssetsEmitted(out, `${config.base}${config.build.assetsDir}/`)
		}
	}
}

// Every script or wasm the emitted JS loads from the assets directory must have been emitted (see the rayon note
// above): a missing worker chunk only surfaces as a boot hang. The hashed SDK wasm removed above is never loaded.
function assertReferencedAssetsEmitted(out: string, prefix: string): void {
	const reference = new RegExp(`["'\`]${prefix.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\w.-]+\\.(?:m?js|wasm))["'\`]`, "g")
	const missing: string[] = []

	for (const file of readdirSync(out)) {
		if (!/\.m?js$/.test(file)) {
			continue
		}

		for (const [, name] of readFileSync(join(out, file), "utf8").matchAll(reference)) {
			if (name !== undefined && !/^sdk-rs_bg-.*\.wasm$/.test(name) && !existsSync(join(out, name))) {
				missing.push(`${file} -> ${name}`)
			}
		}
	}

	if (missing.length > 0) {
		throw new Error(`the build references assets it never emitted:\n${missing.join("\n")}`)
	}
}
