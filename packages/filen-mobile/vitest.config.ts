import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	test: {
		environment: "node",
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.{idea,git,cache,output,temp}/**",
			"filen-rs/**",
			"filen-ios-file-provider/**",
			"filen-android-documents-provider/**"
		]
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"react-native": path.resolve(__dirname, "./src/tests/mocks/reactNative.ts")
		}
	}
})
