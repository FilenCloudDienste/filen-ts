import { defineConfig } from "vite"

// Separate build for the service worker: sw.ts imports nothing but @/lib/sw/protocol, so none of the
// main config's plugins (React, Tailwind, the router codegen, SDK-artifact copying) apply here — a
// single unhashed ES entry written straight to the dist root, no code-splitting, no public-dir copy.
export default defineConfig({
	resolve: { alias: { "@": "/src" } },
	build: {
		// Runs after the app build in the chained `build` script — must not wipe its output, and there's
		// nothing under public/ this build needs to (re-)copy.
		emptyOutDir: false,
		copyPublicDir: false,
		minify: "oxc",
		rollupOptions: {
			input: "src/sw/sw.ts",
			output: {
				format: "es",
				entryFileNames: "sw.js"
			}
		}
	}
})
