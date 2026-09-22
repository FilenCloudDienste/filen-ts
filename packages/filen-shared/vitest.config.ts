import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	resolve: {
		alias: {
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
