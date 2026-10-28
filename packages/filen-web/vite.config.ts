import type { OutgoingHttpHeaders } from "node:http"
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import babel from "@rolldown/plugin-babel"
import { sdkArtifacts, COI_HEADERS, SDK_ARTIFACTS } from "./vite/sdk-artifacts-plugin"
import { officeFonts, OFFICE_FONTS_BASE } from "./vite/office-fonts-plugin"
import { spellcheckAssets, SPELLCHECK_BASE } from "./vite/spellcheck-assets-plugin"
import { SINGLETONS } from "./vite/singletons"
import { assistantModelDev } from "./vite/assistant-model"
import { isAllowedModelOrigin } from "./src/features/assistant/runtime/manifest"

// Vite's header options only reach the responses it serves with a body: the 304 Not Modified that
// answers a revalidation goes out bare, from the preview's static handler and the dev server's module
// transform alike, and WebKit then refuses a worker script revalidated on reload for want of COEP.
// Every response carries them, as the deployment must (README § Deployment). Dev sends server.headers.
function responseHeaders(preview: OutgoingHttpHeaders): Plugin {
	const setAll =
		(headers: OutgoingHttpHeaders): Connect.NextHandleFunction =>
		(_request, response, next) => {
			for (const [name, value] of Object.entries(headers)) {
				if (value !== undefined) {
					response.setHeader(name, value)
				}
			}

			next()
		}

	return {
		name: "filen:response-headers",
		configureServer(server) {
			server.middlewares.use(setAll(server.config.server.headers))
		},
		configurePreviewServer(server) {
			server.middlewares.use(setAll(preview))
		}
	}
}

// The deployment's dist/_headers (Cloudflare static assets, README § Deployment), from the same set the
// preview server sends. Rules apply in file order and a rule's removals run before its own values, so
// the unhashed SDK artifacts can drop the immutable caching /assets/* grants: their names never change,
// so they must be revalidated on every load or a client pairs new code with an old SDK. The office fonts'
// licence files are unhashed too (the fonts themselves are content-hashed under /assets/), as are the
// spellcheck dictionaries' (the engine and dictionaries are hashed under /assets/spellcheck/).
// FILEN_WEB_NOINDEX keeps the staging deployment out of search indexes.
function deployHeaders(headers: Record<string, string>): Plugin {
	const rule = (path: string, lines: string[]) => [path, ...lines.map(line => `  ${line}`)].join("\n")
	const revalidate = ["! Cache-Control", "Cache-Control: no-cache"]

	return {
		name: "filen:deploy-headers",
		apply: "build",
		generateBundle() {
			const every = Object.entries(headers).map(([name, value]) => `${name}: ${value}`)

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
						rule("/assets/snippets/*", revalidate),
						rule(`${OFFICE_FONTS_BASE}*`, revalidate),
						rule(`${SPELLCHECK_BASE}*`, revalidate)
					].join("\n") + "\n"
			})
		}
	}
}

// ArkType decides whether it may compile its validators by evaluating `new Function` when its schema
// module loads. The CSP below never allows eval, so the answer is fixed: the probe only throws, which
// Firefox reports as a CSP violation on every load. The build states the answer instead, and fails if
// ArkType stops deciding it this way, so an upgrade cannot silently bring the probe back.
function arkTypeJitless(): Plugin {
	const probe = "jitless: envHasCsp()"

	return {
		name: "filen:arktype-jitless",
		apply: "build",
		transform(code, id) {
			if (!/[\\/]@ark[\\/]schema[\\/]out[\\/]kinds\.js$/.test(id)) {
				return null
			}

			if (!code.includes(probe)) {
				this.error(`@ark/schema no longer sets "${probe}"; revisit filen:arktype-jitless`)
			}

			return code.replace(probe, "jitless: true")
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
// One Filen host family: its .filen.io host plus the .filen.net and .filen-1.net … .filen-6.net failovers.
function filenHostFamily(subdomain: string): string[] {
	return ["filen.io", "filen.net", "filen-1.net", "filen-2.net", "filen-3.net", "filen-4.net", "filen-5.net", "filen-6.net"].map(
		domain => `https://${subdomain}.${domain}`
	)
}

// The assistant's model host (features/assistant/runtime): the default, cdn.filen.io, is already inside
// https://*.filen.io below; a build pointed elsewhere with VITE_ASSISTANT_MODEL_BASE_URL gets exactly that
// origin added, and nothing else.
function assistantModelSources(mode: string): string[] {
	const configured = loadEnv(mode, process.cwd(), "VITE_ASSISTANT_MODEL_")["VITE_ASSISTANT_MODEL_BASE_URL"]

	if (configured === undefined || configured === "") {
		return []
	}

	const url = new URL(configured)

	if (!isAllowedModelOrigin(url)) {
		throw new Error(`VITE_ASSISTANT_MODEL_BASE_URL must be https: ${configured}`)
	}

	return [url.origin]
}

const contentSecurityPolicy = (connectExtra: readonly string[]) =>
	[
		"default-src 'none'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"worker-src 'self' blob:",
		"style-src 'self' 'unsafe-inline'",
		"font-src 'self'",
		// cdn.filen.io hosts the custom emoji pack (emoji.ts); avatar pictures (account/contacts/chat rows'
		// avatarURL) come from the API on either the egest or the down family, each with the .net failover set
		// connect-src already carries — all sanctioned first-party hosts, not attacker-reachable third parties.
		`img-src 'self' blob: data: https://cdn.filen.io ${[...filenHostFamily("egest"), ...filenHostFamily("down")].join(" ")}`,
		// <video>/<audio> element sources — 'self' for the SW's inline-preview route (same-origin, never a
		// cross-origin media host), blob: for the buffered-fallback object URL (dev / SW absent / a failed
		// stream registration). Was absent from the CSP entirely until the preview feature needed it —
		// default-src 'none' blocks every <video>/<audio> src fetch outright without this directive; a plain
		// <img> also joins the SW's inline route now but is governed by img-src above, not this one.
		"media-src 'self' blob:",
		// filen-controlled domains only — the .net / .filen-N.net families are the SDK's baked-in
		// failover hosts (present in the wasm binary); removing them silently breaks failover.
		// cdn.filen.io also serves the assistant's model files (fetched by its worker); see assistantModelSources.
		[
			"connect-src 'self' https://*.filen.io wss://*.filen.io https://*.filen.net wss://*.filen.net https://*.filen-1.net https://*.filen-2.net https://*.filen-3.net https://*.filen-4.net https://*.filen-5.net https://*.filen-6.net",
			...connectExtra
		].join(" "),
		"manifest-src 'none'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'"
	].join("; ")

const previewHeaderSet = (mode: string): Record<string, string> => ({
	...COI_HEADERS,
	"Content-Security-Policy": contentSecurityPolicy(assistantModelSources(mode)),
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()"
})

export default defineConfig(({ mode }) => ({
	plugins: [
		responseHeaders(previewHeaderSet(mode)),
		deployHeaders(previewHeaderSet(mode)),
		arkTypeJitless(),
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
		sdkArtifacts(),
		officeFonts(),
		spellcheckAssets(),
		assistantModelDev()
	],
	// Workspace packages are compiled from source, so their bare imports resolve from their own directory,
	// where pnpm links their own (dev) copies: @filen/office's react is not the app's. One copy of each
	// singleton, resolved from this package; a package name covers its subpaths (react/jsx-runtime, and
	// react/compiler-runtime that the React Compiler injects into those sources too).
	resolve: {
		alias: [{ find: "@", replacement: "/src" }],
		dedupe: SINGLETONS
	},
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
	// The workers and the service worker are scan entries of their own: the scan treats a `?worker` import as
	// external, so a worker's dependencies would only be found when it first runs, and re-optimizing then
	// reloads the page under it (the assistant's model download among it). Explicit entries replace the default
	// html glob, so index.html is listed too.
	optimizeDeps: {
		entries: ["index.html", "src/**/*.worker.ts", "src/sw/sw.ts"],
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
		},
		// The desktop shell's dev mode (filen-desktop scripts/dev.ts) loads the page from its own filen:// origin,
		// which the HMR client would otherwise take as this server's host.
		...(process.env["FILEN_DESKTOP_HMR_PORT"] === undefined
			? {}
			: { hmr: { protocol: "ws", host: "localhost", clientPort: Number(process.env["FILEN_DESKTOP_HMR_PORT"]) } })
	},
	// The preview headers are set by responseHeaders() (plugins above), not preview.headers.
	// Each worker is one file too, for the same reason as the page's bundle.
	// Rolldown keeps `/* @__PURE__ */` annotations in minified output unless told otherwise, and Vite only says so
	// for the page build: ~70 KB of comments across the workers.
	worker: {
		format: "es",
		plugins: () => [officeFonts()],
		rolldownOptions: { output: { codeSplitting: false, comments: { annotation: false } } }
	}
}))
