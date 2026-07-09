import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default defineConfig([
	globalIgnores(["dist", "docs", "src/routeTree.gen.ts", "src/lib/sdk/error-kinds.gen.ts"]),
	{
		files: ["**/*.{ts,tsx}"],
		extends: [
			js.configs.recommended,
			...tseslint.configs.strictTypeChecked,
			...tseslint.configs.stylisticTypeChecked,
			reactHooks.configs.flat["recommended-latest"], // hooks v7 incl. React Compiler rules
			reactRefresh.configs.vite
		],
		languageOptions: {
			globals: globals.browser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
		},
		rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
	},
	{
		// shadcn registry output: primitives export a `cva` variants helper
		// alongside the component, which react-refresh can't fast-refresh.
		// Keep these files registry-verbatim instead of splitting them.
		files: ["src/components/ui/**/*.{ts,tsx}"],
		// Also relaxed: some registry files use `Array<T>` / defensive optional chains that our strict
		// config would flag. Scoped to the vendored ui/ dir so app code stays fully strict.
		rules: {
			"react-refresh/only-export-components": "off",
			"@typescript-eslint/array-type": "off",
			"@typescript-eslint/no-unnecessary-condition": "off"
		}
	},
	{
		// TanStack Router file routes export a `Route` constant (not a component) by convention and use
		// `throw redirect()` / `throw notFound()` as the framework's control-flow idiom — neither is a
		// code smell here, so the two rules that would flag them are scoped off for route files.
		files: ["src/routes/**/*.{ts,tsx}"],
		rules: {
			"react-refresh/only-export-components": "off",
			"@typescript-eslint/only-throw-error": "off"
		}
	},
	{
		// The shared unauthed-page guard throws the router's `redirect()` — the same framework
		// control-flow idiom the route files use, extracted so /login and /register share one guard.
		files: ["src/features/auth/lib/guard.ts"],
		rules: {
			"@typescript-eslint/only-throw-error": "off"
		}
	},
	{
		// `@/*` maps to `./src/*` (tsconfig + vite alias + shadcn components.json all agree),
		// so every file under src can reach every other file under src through it — no
		// legitimate relative import can exist here. Scoped to src/ only: vite.config.ts,
		// scripts/*, and vite/* live outside the alias's mapped root and need relative imports.
		files: ["src/**/*.{ts,tsx}"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["./*", "../*"],
							message: 'Use the "@/..." alias instead of a relative import.'
						}
					]
				}
			]
		}
	},
	{
		// e2e specs are Playwright/Node, not React — the react plugins don't apply, and Playwright's
		// fixture `use` callback trips rules-of-hooks (it reads `use` as the React hook).
		files: ["e2e/**/*.ts"],
		rules: {
			"react-hooks/rules-of-hooks": "off",
			"react-refresh/only-export-components": "off"
		}
	},
	// Must stay last — turns off stylistic rules that would otherwise fight prettier's output.
	eslintConfigPrettier
])
