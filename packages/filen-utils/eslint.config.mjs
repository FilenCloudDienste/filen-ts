import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["node_modules/**/*", "dist/**/*"]
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
			]
		}
	}
)
