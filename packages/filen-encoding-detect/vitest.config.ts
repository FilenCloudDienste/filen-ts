import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		// The tests run the wasm module; building it (incremental cargo) happens once per run.
		globalSetup: ["src/tests/globalSetup.ts"],
		isolate: true,
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true
	}
})
