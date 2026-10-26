import js from "@eslint/js"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default defineConfig(
	globalIgnores(["dist", "release", "docs"]),
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			eqeqeq: 2,
			"no-duplicate-imports": "error",
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
	eslintConfigPrettier
)
