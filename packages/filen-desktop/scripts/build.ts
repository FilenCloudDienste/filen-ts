import { build, type BuildOptions } from "esbuild"

// Main is ESM; the sandboxed preload cannot load ESM, so it is a CJS bundle that only requires "electron".
const common = {
	bundle: true,
	platform: "node",
	target: "node24",
	external: ["electron"],
	sourcemap: true,
	logLevel: "warning",
	minify: process.env["NODE_ENV"] === "production"
} satisfies BuildOptions

await Promise.all([
	build({
		...common,
		entryPoints: ["src/main/index.ts"],
		outfile: "dist/main.js",
		format: "esm",
		// Bundled CommonJS packages (electron-updater and its dependencies) require Node built-ins, which an ESM bundle
		// only reaches through a require of its own.
		banner: {
			js: 'import { createRequire as __filenCreateRequire } from "node:module"; const require = __filenCreateRequire(import.meta.url);'
		}
	}),
	build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", format: "cjs" })
])
