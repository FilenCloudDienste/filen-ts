import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import babel from "@rolldown/plugin-babel"
import { sdkArtifacts } from "./vite/sdk-artifacts-plugin"

const COI_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
	"Cross-Origin-Resource-Policy": "same-origin"
} as const

// Hardened CSP, preview/prod only (the dev server needs HMR inline/eval).
// connect-src: the JS glue (sdk-rs.js) contains NO literal hosts, but the wasm BINARY does —
// confirmed by running `strings` over sdk-rs_bg.wasm: egest/gateway/ingest hosts across
// filen.net and filen-1.net … filen-6.net FAILOVER domains, plus socket.filen.io (wss). The
// current *.filen.io wildcard therefore BLOCKS SDK failover — connect-src must be EXPANDED
// (add the .net host families), not tightened.
// style-src DOES need 'unsafe-inline' — verified empirically (built preview, real Chrome,
// devtools console): ThemeProvider's disableTransitionsTemporarily()
// (src/components/theme-provider.tsx) injects a literal `document.createElement("style")`
// with a fixed, non-user-controlled transition-suppression rule on every theme change —
// this is app-authored content, not attacker-reachable, so 'unsafe-inline' here doesn't
// open a script-executable hole (CSP still blocks script-src unsafe-inline unconditionally).
// The browser's own violation report offered a sha256 hash of that exact rule as a stricter
// alternative; not used here because it silently breaks the moment that literal string
// changes — 'unsafe-inline' for styles only is a deliberate, narrowly-scoped exception
// (the non-negotiable floor stays on script-src).
const CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline'",
	"font-src 'self'",
	"img-src 'self' blob: data:",
	// filen-controlled domains only — the .net / .filen-N.net families are the SDK's baked-in
	// failover hosts (present in the wasm binary); removing them silently breaks failover.
	"connect-src 'self' https://*.filen.io wss://*.filen.io https://*.filen.net wss://*.filen.net https://*.filen-1.net https://*.filen-2.net https://*.filen-3.net https://*.filen-4.net https://*.filen-5.net https://*.filen-6.net",
	"manifest-src 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'"
].join("; ")

export default defineConfig({
	plugins: [
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
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
	optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
	// Vite 8 already defaults both of these on (verified against the installed package's
	// own types: `minify` defaults to 'oxc', `cssMinify` to 'lightningcss') — pinned
	// explicitly so a future Vite default change can't silently soften production output.
	// No built-in HTML minifier exists in Vite 8 (checked); the ~0.5kB index.html shell
	// isn't worth a new plugin dependency for it. 'terser' would trade build speed for a
	// historically marginal size win over oxc — not worth it unless profiling says otherwise.
	build: {
		minify: "oxc",
		cssMinify: "lightningcss"
	},
	server: { headers: COI_HEADERS },
	preview: {
		headers: {
			...COI_HEADERS,
			"Content-Security-Policy": CSP,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()"
		}
	},
	worker: { format: "es" }
})
