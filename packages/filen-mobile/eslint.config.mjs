import js from "@eslint/js"
import { FlatCompat } from "@eslint/eslintrc"
import reactHooks from "eslint-plugin-react-hooks"
import typescript from "@typescript-eslint/eslint-plugin"
import typescriptParser from "@typescript-eslint/parser"
import reactCompiler from "eslint-plugin-react-compiler"
import importPlugin from "eslint-plugin-import"

const compat = new FlatCompat()

export default [
	js.configs.recommended,
	...compat.extends(
		"expo",
		"plugin:@typescript-eslint/recommended",
		"plugin:react-hooks/recommended",
		"plugin:@typescript-eslint/eslint-recommended",
		"plugin:@tanstack/eslint-plugin-query/recommended",
		"plugin:react/recommended"
	),
	{
		ignores: [
			"node_modules/**/*",
			"patches/**/*",
			"android/**/*",
			"ios/**/*",
			".vscode/**/*",
			".expo/**/*",
			".git/**/*",
			".maestro/**/*",
			"filen-rs/**/*",
			"filen-android-documents-provider/**/*",
			"filen-ios-file-provider/**/*",
			".github/**/*",
			"metro.config.js",
			"tailwind.config.js",
			"index.js",
			"eslint.config.mjs",
			"metro.config.js",
			"plugins/**/*",
			"src/uniwind-types.d.ts",
			"src/global.css",
			"src/tests/**/*"
		]
	},
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser: typescriptParser
		},
		plugins: {
			"@typescript-eslint": typescript,
			"react-hooks": reactHooks,
			"react-compiler": reactCompiler,
			import: importPlugin
		},
		rules: {
			eqeqeq: 2,
			quotes: ["error", "double"],
			"no-mixed-spaces-and-tabs": 0,
			"no-duplicate-imports": "error",
			"no-extra-semi": 0,
			"@typescript-eslint/ban-types": "off",
			"react/react-in-jsx-scope": "off",
			"react/prop-types": "off",
			"react/display-name": "warn",
			"react-compiler/react-compiler": "error",
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
					patterns: [".*"]
				}
			],
			"react-hooks/exhaustive-deps": [
				"warn",
				{
					additionalHooks: "(useMemoDeep|useCallbackDeep)"
				}
			]
		},
		settings: {
			"import/resolver": {
				typescript: {
					alwaysTryTypes: true,
					project: "./tsconfig.json"
				}
			}
		}
	},
	{
		settings: {
			react: {
				version: "detect"
			}
		}
	}
]
