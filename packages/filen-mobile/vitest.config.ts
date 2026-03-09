import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	test: {
		environment: "node"
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"react-native": path.resolve(__dirname, "./src/tests/mocks/reactNative.ts")
		}
	}
})
