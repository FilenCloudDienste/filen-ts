import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"
import { defineConfig, globalIgnores } from "eslint/config"

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
		rules: { "react-refresh/only-export-components": "off" }
	}
])
