import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	resolve: {
		// First match wins and a bare key also matches its "/sub" paths, so the subpath goes first.
		alias: {
			"@filen/shared/dom": path.resolve(__dirname, "./src/dom/index.ts"),
			"@filen/shared/tooling": path.resolve(__dirname, "./src/tooling/licenseNotices.ts"),
			"@filen/shared": path.resolve(__dirname, "./src/index.ts")
		}
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		isolate: true,
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true
	}
})
