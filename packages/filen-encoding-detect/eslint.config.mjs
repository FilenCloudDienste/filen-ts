import js from "@eslint/js"
import tseslint from "typescript-eslint"

// The detector runs on a page, in a worker and in Node tests alike: no platform
// framework may enter them, and nothing here may depend on a host app.
const platformPatterns = [
	{
		group: ["node:*", "react", "react-dom", "react-dom/*", "react-native", "react-native/*", "expo", "expo-*", "@expo/*"],
		message: "@filen/encoding-detect's runtime code is platform-free: no Node, React, React Native or Expo imports."
	}
]

const appPatterns = [
	{
		group: ["@filen/web", "@filen/web/*", "@filen/mobile", "@filen/mobile/*", "@filen/desktop", "@filen/desktop/*"],
		message: "@filen/encoding-detect is used by the apps, never the other way round."
	}
]

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["node_modules/**/*", "crate/**/*", "dist/**/*"]
	},
	{
		files: ["**/*.{ts,mjs}"],
		rules: {
			eqeqeq: 2,
			quotes: ["error", "double", { avoidEscape: true }],
			"no-mixed-spaces-and-tabs": 0,
			"no-duplicate-imports": "error",
			"no-extra-semi": 0,
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_"
				}
			],
			"no-restricted-imports": ["error", { patterns: appPatterns }]
		}
	},
	{
		files: ["src/**/*.ts"],
		ignores: ["src/tests/**"],
		rules: {
			"no-restricted-imports": ["error", { patterns: [...platformPatterns, ...appPatterns] }]
		}
	},
	{
		files: ["scripts/**/*.mjs"],
		languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } }
	}
)
