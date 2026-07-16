import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	test: {
		environment: "node",
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"**/.{idea,git,cache,output,temp}/**",
			"**/.claude/**",
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
			// The native filen-exif module calls requireNativeModule() at import — unloadable in
			// Node — so alias it to a mock globally (must precede the "@/modules" alias below).
			"@/modules/filen-exif": path.resolve(__dirname, "./src/tests/mocks/filenExif.ts"),
			// Local Expo modules live under ./modules (not ./src). Must precede the "@" alias so
			// "@/modules/*" resolves there rather than "./src/modules/*". Mirrors the app's babel/metro
			// "@/modules/" → "modules/" alias.
			"@/modules": path.resolve(__dirname, "./modules"),
			"@": path.resolve(__dirname, "./src"),
			"react-native": path.resolve(__dirname, "./src/tests/mocks/reactNative.ts"),
			// uniffi-bindgen-react-native ships CJS under "type": "module" → unloadable in Node. The
			// shared serializer imports it (UniffiEnum), and the diagnostic logger now imports the
			// serializer, so it reaches nearly every test. Alias it to the minimal mock globally (like
			// react-native) instead of per-file vi.mock.
			"uniffi-bindgen-react-native": path.resolve(__dirname, "./src/tests/mocks/uniffiBindgenReactNative.ts")
		}
	}
})
