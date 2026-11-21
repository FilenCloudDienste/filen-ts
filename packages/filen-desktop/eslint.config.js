import js from "@eslint/js"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default defineConfig(
	globalIgnores([
		"dist",
		"release",
		"docs",
		"filen-ios-file-provider",
		"filen-rs",
		"build/assistant-bench",
		"build/assistant-engine",
		"build/native"
	]),
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			eqeqeq: 2,
			"no-duplicate-imports": "error",
			// Only the addon loaded at runtime supplies sdk-rs values; the package itself is never bundled.
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					paths: [
						{
							name: "@filen/sdk-rs",
							message: "Import @filen/sdk-rs types only; runtime values come from the loaded addon.",
							allowTypeImports: true
						}
					]
				}
			],
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_"
				}
			]
		}
	},
	{
		// The sandboxed preload can only require "electron"; anything else must be bundled from src/shared.
		files: ["src/preload/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{ group: ["node:*", "../main/*"], message: "The sandboxed preload has no Node and never imports main code." }
					]
				}
			]
		}
	},
	{
		// The native host and the assistant's engine run in processes of their own and talk to main only through the
		// validated protocols in src/shared.
		files: ["src/native/**", "src/assistant/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{ patterns: [{ group: ["../main/*"], message: "The native host never imports main code; share it through src/shared." }] }
			]
		}
	},
	eslintConfigPrettier
)
