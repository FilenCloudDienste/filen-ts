import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		// Replaces Vite's server defaults, so they are listed again after the sdk-rs napi condition.
		conditions: ["filen-desktop", "module", "node", "development|production"]
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
