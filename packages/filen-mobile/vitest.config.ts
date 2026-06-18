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
	plugins: [
		{
			// In vitest's node environment, require("@/...svg") calls go through
			// Node's CJS resolver which doesn't know about vite's "@/" alias.
			// This plugin intercepts the transform of .tsx/.ts files and rewrites
			// require("@/.../something.svg") → 0 so the runtime never hits Node's resolver.
			name: "vitest-svg-require-stub",
			transform(code: string, id: string) {
				if ((id.endsWith(".tsx") || id.endsWith(".ts")) && code.includes(".svg")) {
					return {
						code: code.replace(/require\(["'][^"']*\.svg["']\)/g, "0"),
						map: null
					}
				}

				return null
			}
		}
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"react-native": path.resolve(__dirname, "./src/tests/mocks/reactNative.ts")
		}
	}
})
