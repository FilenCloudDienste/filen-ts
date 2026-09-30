import { defineConfig } from "vitest/config"

export default defineConfig({
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
