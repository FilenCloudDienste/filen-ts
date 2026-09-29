import js from "@eslint/js"
import tseslint from "typescript-eslint"

// @filen/shared must compile on Hermes and in the browser, so nothing platform-bound may enter it.
const parentEscapePattern = {
	regex: "^\\.\\.",
	message: "Parent-escaping relative imports leave the package; import siblings with \"./\"."
}

const platformFreeImportPatterns = [
	parentEscapePattern,
	{
		group: ["node:*", "react", "react-dom", "react-native", "react-native/*", "expo", "expo-*", "@expo/*"],
		message: "@filen/shared is platform-free: no Node, React, React Native or Expo imports."
	}
]

// Reaching the barrel from inside the package routes every value import through index.ts,
// which is an initialisation-order hazard on Metro/Hermes.
const selfImportPattern = {
	group: ["@filen/shared", "@filen/shared/*"],
	message: "Import the sibling module directly instead of the package barrel."
}

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["node_modules/**/*"]
	},
	{
		files: ["**/*.ts"],
		rules: {
			eqeqeq: 2,
			quotes: ["error", "double"],
			"no-mixed-spaces-and-tabs": 0,
			"no-duplicate-imports": "error",
			"no-extra-semi": 0,
			"@typescript-eslint/ban-types": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_"
				}
			],
			"no-restricted-imports": [
				"error",
				{
					patterns: [...platformFreeImportPatterns, selfImportPattern]
				}
			]
		}
	},
	{
		// Tests reach the package through the "@filen/shared" alias
		files: ["src/tests/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: platformFreeImportPatterns
				}
			]
		}
	},
	{
		// Node-only build tooling behind the "@filen/shared/tooling" subpath; never re-exported from index.ts.
		files: ["src/tooling/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [parentEscapePattern, selfImportPattern]
				}
			]
		}
	},
	{
		files: ["src/tests/tooling/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [parentEscapePattern]
				}
			]
		}
	}
)
