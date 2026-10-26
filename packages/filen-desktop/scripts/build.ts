import { existsSync, readFileSync } from "node:fs"
import { build, type BuildOptions } from "esbuild"

// Main and the native host (the sync engine's utility process) are ESM; the sandboxed preload cannot load ESM, so it is a
// CJS bundle that only requires "electron".
const common = {
	bundle: true,
	platform: "node",
	target: "node24",
	external: ["electron"],
	sourcemap: true,
	logLevel: "warning",
	minify: process.env["NODE_ENV"] === "production"
} satisfies BuildOptions

// Bundled CommonJS packages (electron-updater and its dependencies) require Node built-ins, which an ESM bundle only
// reaches through a require of its own.
const esmRequire = {
	js: 'import { createRequire as __filenCreateRequire } from "node:module"; const require = __filenCreateRequire(import.meta.url);'
}

// The sha256 of each staged Linux rclone (scripts/stageRclone.ts), which main hands the native host to check the
// binary against; {} elsewhere, where the binary is signed instead.
const rcloneManifest = "build/rclone/manifest.json"
const rcloneSha256 = existsSync(rcloneManifest) ? readFileSync(rcloneManifest, "utf8").trim() : "{}"

await Promise.all([
	build({
		...common,
		entryPoints: ["src/main/index.ts"],
		outfile: "dist/main.js",
		format: "esm",
		banner: esmRequire,
		define: { __FILEN_RCLONE_SHA256__: rcloneSha256 }
	}),
	// @filen/sdk-rs is imported for its types only; the addon is loaded at runtime by path.
	build({
		...common,
		entryPoints: ["src/native/index.ts"],
		outfile: "dist/native.js",
		format: "esm",
		conditions: ["filen-desktop"],
		banner: esmRequire
	}),
	build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", format: "cjs" })
])
