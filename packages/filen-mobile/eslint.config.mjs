import js from "@eslint/js"
import { FlatCompat } from "@eslint/eslintrc"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"
import reactCompiler from "eslint-plugin-react-compiler"
import importPlugin from "eslint-plugin-import"

const compat = new FlatCompat()

// --- Feature-based architecture guardrails (added after the src/features/ migration) ---
// Zustand hooks must always take a selector — a bare useXStore() subscribes to the whole
// store and re-renders on every change.
const ZUSTAND_SELECTOR_RULE = {
	selector: "CallExpression[callee.name=/^use[A-Z][a-zA-Z]*Store$/][arguments.length=0]",
	message:
		"Zustand store hooks must be called with a selector — e.g. useXStore(s => s.foo) or useXStore(useShallow(...)); never a bare useXStore()."
}
// No barrel re-export aggregators inside features/ (hurt Metro tree-shaking + fast refresh).
const NO_FEATURE_BARREL_RULE = {
	selector: "ExportAllDeclaration",
	message: "No barrel re-exports (export * from ...) inside src/features/ — import the specific module directly."
}

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
			"plugins/**/*",
			"scripts/**/*",
			"src/uniwind-types.d.ts",
			"src/global.css",
			"src/tests/**/*"
		]
	},
	{
		files: ["**/*.ts", "**/*.tsx"],
		languageOptions: {
			parser: tseslint.parser
		},
		plugins: {
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
			"react/display-name": "off",
			"react-compiler/react-compiler": "error",
			"react-hooks/preserve-manual-memoization": "error",
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
			"no-restricted-syntax": ["error", ZUSTAND_SELECTOR_RULE],
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
		// No barrel re-exports inside features/ (in addition to the project-wide zustand rule).
		files: ["src/features/**/*.ts", "src/features/**/*.tsx"],
		rules: {
			"no-restricted-syntax": ["error", ZUSTAND_SELECTOR_RULE, NO_FEATURE_BARREL_RULE]
		}
	},
	{
		// Routes stay thin: a route only re-exports a feature screen or renders a feature
		// component. It must not import feature stores/queries (that's logic — it belongs in
		// the feature's screen/hook). _layout.tsx (providers/registration) and +native-intent
		// (deep-link handling) are exempt.
		files: ["src/routes/**/*.ts", "src/routes/**/*.tsx"],
		ignores: ["src/routes/**/_layout.tsx", "src/routes/+native-intent.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: [".*"]
						},
						{
							group: ["@/features/*/store", "@/features/*/store/*", "@/features/*/queries", "@/features/*/queries/*"],
							message:
								"Routes must stay thin — no feature store/query imports. Move logic into the feature's screen/hook; the route should only re-export or render a feature screen/component."
						}
					]
				}
			]
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
