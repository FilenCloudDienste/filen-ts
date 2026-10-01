import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import babel from "@rolldown/plugin-babel"
import { sdkArtifacts, COI_HEADERS, SDK_ARTIFACTS } from "./vite/sdk-artifacts-plugin"

// preview.headers only reaches the responses the static handler serves with a body: its 304 Not
// Modified goes out bare, and WebKit then refuses a worker script revalidated on reload for want of
// COEP. Every response carries them, as the deployment must (README § Deployment).
function previewHeaders(): Plugin {
	return {
		name: "filen:preview-headers",
		configurePreviewServer(server) {
			server.middlewares.use((_request, response, next) => {
				for (const [name, value] of Object.entries(PREVIEW_HEADERS)) {
					response.setHeader(name, value)
				}

				next()
			})
		}
	}
}

// The deployment's dist/_headers (Cloudflare static assets, README § Deployment), from the same set the
// preview server sends. Rules apply in file order and a rule's removals run before its own values, so
// the unhashed SDK artifacts can drop the immutable caching /assets/* grants: their names never change,
// so they must be revalidated on every load or a client pairs new code with an old SDK.
// FILEN_WEB_NOINDEX keeps the staging deployment out of search indexes.
function deployHeaders(): Plugin {
	const rule = (path: string, lines: string[]) => [path, ...lines.map(line => `  ${line}`)].join("\n")
	const revalidate = ["! Cache-Control", "Cache-Control: no-cache"]

	return {
		name: "filen:deploy-headers",
		apply: "build",
		generateBundle() {
			const every = Object.entries(PREVIEW_HEADERS).map(([name, value]) => `${name}: ${value}`)

			if (process.env["FILEN_WEB_NOINDEX"] === "1") {
				every.push("X-Robots-Tag: noindex")
			}

			this.emitFile({
				type: "asset",
				fileName: "_headers",
				source:
					[
						rule("/*", every),
						rule("/assets/*", ["Cache-Control: public, max-age=31536000, immutable"]),
						...SDK_ARTIFACTS.map(name => rule(`/assets/${name}`, revalidate)),
						rule("/assets/snippets/*", revalidate)
					].join("\n") + "\n"
			})
		}
	}
}

// Hardened CSP, preview/prod only (the dev server needs HMR inline/eval).
// connect-src: the JS glue (sdk-rs.js) contains NO literal hosts, but the wasm BINARY does —
// confirmed by running `strings` over sdk-rs_bg.wasm: egest/gateway/ingest hosts across
// filen.net and filen-1.net … filen-6.net FAILOVER domains, plus socket.filen.io (wss). The
// current *.filen.io wildcard therefore BLOCKS SDK failover — connect-src must be EXPANDED
// (add the .net host families), not tightened.
// style-src DOES need 'unsafe-inline' — verified empirically (built preview, real Chrome, devtools
// console). Two independent sources inject parsed inline styles that CSP style-src-elem blocks
// otherwise: (1) ThemeProvider's disableTransitionsTemporarily() appends a literal
// `document.createElement("style")` transition-suppression rule on every theme change, and (2) Base
// UI (@base-ui/react) injects its own runtime `<style>` elements on mount (an empty one plus a rule
// set — observed as sha256-47DEQ… [empty] and sha256-CIxDM… violations). Both are app/library-authored,
// not attacker-reachable, so 'unsafe-inline' for STYLES only does not open a script hole (script-src
// keeps its unconditional no-unsafe-inline floor). A moving set of sha256 hashes was rejected as too
// brittle (the hashes shift when either source's literal changes). Replacing (1) with a predefined
// toggled class was tried and does NOT suffice on its own — (2) still requires 'unsafe-inline'.
const CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	// cdn.filen.io hosts the custom emoji pack (emoji.ts); the egest.filen.* family (same .net-N
	// failover set connect-src already carries) hosts avatar pictures (account/contacts/chat rows'
	// avatarURL) — both are sanctioned first-party hosts, not attacker-reachable third parties.
	"img-src 'self' blob: data: https://cdn.filen.io https://egest.filen.io https://egest.filen.net https://egest.filen-1.net https://egest.filen-2.net https://egest.filen-3.net https://egest.filen-4.net https://egest.filen-5.net https://egest.filen-6.net",
	// <video>/<audio> element sources — 'self' for the SW's inline-preview route (same-origin, never a
	// cross-origin media host), blob: for the buffered-fallback object URL (dev / SW absent / a failed
	// stream registration). Was absent from the CSP entirely until the preview feature needed it —
	// default-src 'none' blocks every <video>/<audio> src fetch outright without this directive; a plain
	// <img> also joins the SW's inline route now but is governed by img-src above, not this one.
	"media-src 'self' blob:",
	// filen-controlled domains only — the .net / .filen-N.net families are the SDK's baked-in
	// failover hosts (present in the wasm binary); removing them silently breaks failover.
	"connect-src 'self' https://*.filen.io wss://*.filen.io https://*.filen.net wss://*.filen.net https://*.filen-1.net https://*.filen-2.net https://*.filen-3.net https://*.filen-4.net https://*.filen-5.net https://*.filen-6.net",
	"manifest-src 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'"
].join("; ")

const PREVIEW_HEADERS = {
	...COI_HEADERS,
	"Content-Security-Policy": CSP,
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()"
}

export default defineConfig({
	plugins: [
		previewHeaders(),
		deployHeaders(),
		tanstackRouter({ target: "react", autoCodeSplitting: false }),
		// @rolldown/plugin-babel's real API (verified against the installed 0.2.3 package:
		// README + dist/index.d.mts) is a DEFAULT export taking flat `presets`/`plugins`/`include`
		// options — no named `{ babel }` export and no `babelConfig` wrapper. plugin-react v6 has
		// no Babel of its own (Oxc-based), so without this, babel-plugin-react-compiler never runs
		// and `presets: []` would fail to parse on the first type annotation — hence preset-typescript
		// here too. Must run before react() so Oxc's transform never sees pre-compiler JSX.
		// `@babel/preset-typescript@8` REMOVED `isTSX`/`allExtensions` (verified: build throws
		// "have been removed" otherwise) — v8's default is extension-based JSX detection off the
		// real filename @rolldown/plugin-babel already passes in, which is exactly what we want.
		babel({
			include: /\.tsx?$/,
			presets: ["@babel/preset-typescript"],
			plugins: [["babel-plugin-react-compiler", {}]]
		}),
		react(),
		tailwindcss(),
		sdkArtifacts()
	],
	resolve: { alias: { "@": "/src" } },
	// @sqlite.org/sqlite-wasm's own Vite guidance (README "Usage with vite"): it self-locates
	// sqlite3.wasm and the OPFS async proxy via `new URL(..., import.meta.url)` (verified against
	// the installed 3.53.0-build1 package) — esbuild's dev-time dep pre-bundling would rewrite/copy
	// the module in a way that breaks that relative resolution, so it must bypass optimization.
	// react/compiler-runtime is INCLUDED because nothing imports it in source — the React Compiler
	// injects that import during the Babel transform above, which runs after Vite's dependency scan.
	// Discovered mid-session it re-optimizes the graph and reloads, and every request already in
	// flight for the previous generation's content-hashed chunks 404s on the way through.
	// The service-worker SDK is excluded for the same reason as sqlite-wasm directly above: its glue
	// self-locates its wasm with `new URL("sdk-rs_bg.wasm", import.meta.url)`. Pre-bundled, the glue is
	// moved out of its own directory and that relative URL no longer points at the binary beside it.
	// The page's own SDK is deliberately NOT excluded: pre-bundled, its wasm URL lands in the deps
	// directory, where vite/sdk-artifacts-plugin.ts answers it by basename — which is what that
	// middleware is for. Only the worker's copy needs its real path, because it is the one whose
	// basename is shared with a different binary.
	optimizeDeps: {
		exclude: ["@sqlite.org/sqlite-wasm", "@filen/sdk-rs/service-worker/sdk-rs.js"],
		include: ["react/compiler-runtime"]
	},
	// Vite 8 already defaults both of these on (verified against the installed package's
	// own types: `minify` defaults to 'oxc', `cssMinify` to 'lightningcss') — pinned
	// explicitly so a future Vite default change can't silently soften production output.
	// No built-in HTML minifier exists in Vite 8 (checked); the ~0.5kB index.html shell
	// isn't worth a new plugin dependency for it. 'terser' would trade build speed for a
	// historically marginal size win over oxc — not worth it unless profiling says otherwise.
	// One main-thread script and one stylesheet (workers and wasm stay separate files, as they must):
	// with code splitting, the first visit to a route waited on its chunks, and boot waited on a chain
	// of lazy imports. Measured in throttled Chromium against split, the whole bundle (~1.5 MB
	// compressed) still booted faster at 50 Mbps and to the signed-in shell at 10 Mbps, made first
	// route visits ~10-50 ms instead of 100-300 ms, and cost ~4 MB more JS heap. The router's own
	// splitting is off above for the same reason.
	build: {
		minify: "oxc",
		cssMinify: "lightningcss",
		rolldownOptions: { output: { codeSplitting: false } }
	},
	server: {
		headers: {
			...COI_HEADERS,
			// Dev has no built sw.js, so registerSW points the worker at its SOURCE module and lets this
			// server transform it — which scopes it to /src/sw/ by default. The app needs root scope to
			// see its own download route, and a worker may only claim a scope above its own script when
			// the script's response says so.
			"Service-Worker-Allowed": "/"
		}
	},
	// The preview headers are set by previewHeaders() (plugins above), not preview.headers.
	// Each worker is one file too, for the same reason as the page's bundle.
	worker: { format: "es", rolldownOptions: { output: { codeSplitting: false } } }
})
