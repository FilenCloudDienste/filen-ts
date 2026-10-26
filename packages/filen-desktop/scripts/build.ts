import { build, type BuildOptions, type Plugin } from "esbuild"
import { createRequire, isBuiltin } from "node:module"

// Resolve bare imports with Node's own resolver (pnpm's symlinked node_modules). esbuild otherwise defers to any
// Yarn Plug'n'Play manifest it finds in a parent directory, which can sit above the repo on a developer machine.
const nodeResolution: Plugin = {
	name: "node-resolution",
	setup(builder) {
		builder.onResolve({ filter: /^[^./]/ }, args => {
			if (args.path === "electron" || isBuiltin(args.path) || args.importer === "") {
				return undefined
			}

			return { path: createRequire(args.importer).resolve(args.path) }
		})
	}
}

// Main is ESM; the sandboxed preload cannot load ESM, so it is a CJS bundle that only requires "electron".
const common = {
	bundle: true,
	platform: "node",
	target: "node24",
	external: ["electron"],
	plugins: [nodeResolution],
	sourcemap: true,
	logLevel: "warning",
	minify: process.env["NODE_ENV"] === "production"
} satisfies BuildOptions

await Promise.all([
	build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", format: "esm" }),
	build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", format: "cjs" })
])
