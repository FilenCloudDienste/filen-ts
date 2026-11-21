import { existsSync, readFileSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { BuildOptions, Plugin } from "esbuild"
import { packageDir } from "./paths.ts"

// node-llama-cpp's real directory (pnpm's store), which holds what it reads beside its code and its optional
// dependencies, the prebuilt backends.
export function nodeLlamaCppDir(): string {
	return realpathSync(path.join(packageDir, "node_modules", "node-llama-cpp"))
}

// The assistant engine's bundle; scripts/stageLlama.ts copies it into each staged build/native/<os>-<arch>/llama/.
export const ASSISTANT_ENGINE_BUNDLE = "build/assistant-engine/engine.js"

// Bundled, node-llama-cpp would find its files beside the bundle instead of its own: each of its modules gets the URL
// it has in the package, under node-llama-cpp/ beside the bundle (stageLlama.ts stages what it reads there). Its
// prebuilt backends stay packages of their own (external), found from the bundle's node_modules/@node-llama-cpp/. The
// two modules that would test a binary in a child process keep the bundle's URL, by which node-llama-cpp skips that
// test (the child would be another copy of the app here): main's backend fallback stands in for it, in a process of
// its own.
const UNTESTED = new Set(["testBindingBinary.js", "testCmakeBinary.js"])

export function nodeLlamaCppUrls(): Plugin {
	const root = nodeLlamaCppDir()

	return {
		name: "node-llama-cpp-urls",
		setup: build => {
			build.onLoad({ filter: /\.js$/ }, async args => {
				const real = realpathSync(args.path)

				if (!real.startsWith(`${root}${path.sep}`)) {
					return undefined
				}

				const contents = await readFile(real, "utf8")

				if (UNTESTED.has(path.basename(real)) || !contents.includes("import.meta.url")) {
					return { contents, loader: "js" }
				}

				const relative = JSON.stringify(path.relative(root, real).split(path.sep).join("/"))

				return {
					contents: contents.replaceAll(
						"import.meta.url",
						`new URL(${relative}, new URL("./node-llama-cpp/", import.meta.url)).href`
					),
					loader: "js"
				}
			})
		}
	}
}

// The esbuild bundles: main, the native host and the preload in dist/, and the assistant engine staged beside the asar.
// Shared by build.ts and the third-party notices generator (which reads what they bundle from the same options). Main,
// the native host (the sync engine's utility process) and the assistant engine are ESM; the sandboxed preload cannot
// load ESM, so it is a CJS bundle that only requires "electron".
export function bundleOptions(): BuildOptions[] {
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
	// The native host sends the app's version as rclone's user agent.
	const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string }

	return [
		{
			...common,
			entryPoints: ["src/main/index.ts"],
			outfile: "dist/main.js",
			format: "esm",
			banner: esmRequire,
			define: { __FILEN_RCLONE_SHA256__: rcloneSha256 }
		},
		// @filen/sdk-rs is imported for its types only; the addon is loaded at runtime by path.
		{
			...common,
			entryPoints: ["src/native/main.ts"],
			outfile: "dist/native.js",
			format: "esm",
			conditions: ["filen-desktop"],
			banner: esmRequire,
			define: { __FILEN_DESKTOP_VERSION__: JSON.stringify(version) }
		},
		{ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", format: "cjs" },
		{
			...common,
			entryPoints: ["src/assistant/main.ts"],
			outfile: ASSISTANT_ENGINE_BUNDLE,
			format: "esm",
			banner: esmRequire,
			// reflink (a native addon) is imported only by the model downloader of node-llama-cpp, which the engine never runs.
			external: ["electron", "@node-llama-cpp/*", "@reflink/reflink"],
			plugins: [nodeLlamaCppUrls()]
		}
	]
}
