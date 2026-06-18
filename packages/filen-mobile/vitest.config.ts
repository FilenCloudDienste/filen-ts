import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
	test: {
		environment: "node",
		// The secureStore singleton constructor — now reachable transitively via @/lib/sqlite ->
		// @/lib/secureStore — throws without this env var. Set it for every test file so importing
		// sqlite/cache/secureStore never crashes at module load. Tests can still delete/override it.
		env: {
			EXPO_PUBLIC_SECURE_STORE_UNSECURE_FALLBACK_ENCRYPTION_KEY: "test-fallback-key-1234567890abcdef"
		},
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
			"react-native": path.resolve(__dirname, "./src/tests/mocks/reactNative.ts"),
			// Native modules that throw on import under Node. Aliased to their canonical mocks GLOBALLY
			// so anything transitively importing @/lib/secureStore (via @/lib/sqlite) loads cleanly; a
			// per-test vi.mock still overrides where a test needs a specific variant (e.g. the strict
			// expo-file-system mock).
			"react-native-mmkv": path.resolve(__dirname, "./src/tests/mocks/reactNativeMMKV.ts"),
			"expo-secure-store": path.resolve(__dirname, "./src/tests/mocks/expoSecureStore.ts"),
			"react-native-quick-crypto": path.resolve(__dirname, "./src/tests/mocks/reactNativeQuickCrypto.ts"),
			"expo-file-system": path.resolve(__dirname, "./src/tests/mocks/expoFileSystem.ts")
		}
	}
})
