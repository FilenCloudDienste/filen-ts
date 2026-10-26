import js from "@eslint/js"
import tseslint from "typescript-eslint"

// The core runs in a worker on web, inside a WebView on mobile and next to the file in Hermes, so it may
// not reach any platform: no Node, React, React Native, Expo, or the package's own React layer.
const coreImportPatterns = [
	{
		group: ["node:*", "react", "react-dom", "react-dom/*", "react-native", "react-native/*", "expo", "expo-*", "@expo/*"],
		message: "The office core is platform-free: no Node, React, React Native or Expo imports."
	},
	{
		group: ["**/react/**"],
		message: "The core may not import the React layer."
	},
	{
		group: ["**/dom/**"],
		message: "The core may not import the realm layer."
	}
]

// Builtins Hermes (React Native's engine, which may run core modules next to the file) lacks or only partly
// implements, measured on the RN 0.86 Hermes. The core reaches them only behind a guard: read through
// globalThis (Reflect.get, or a cast to an optional member) and handle their absence, or construct them
// inside try. A typeof check of the member also counts.
const hermesGuard = ":not(TryStatement > BlockStatement.block *, UnaryExpression[operator='typeof'] > *)"
const hermesMessage = "Hermes lacks this builtin: reach it through globalThis with a fallback, or inside try."
const hermesGlobals = [
	"TextDecoder",
	"CompressionStream",
	"DecompressionStream",
	"Response",
	"Blob",
	"structuredClone",
	"FinalizationRegistry",
	"Atomics",
	"SharedArrayBuffer",
	"Float16Array",
	"Iterator",
	"queueMicrotask",
	"MessageChannel",
	"performance",
	"crypto",
	"fetch",
	"window",
	"document",
	"self",
	"navigator"
].map(name => ({ name, message: hermesMessage }))
const hermesMembers = {
	Intl: ["Segmenter", "Locale", "PluralRules", "ListFormat", "DisplayNames", "RelativeTimeFormat", "DurationFormat", "supportedValuesOf"],
	Object: ["groupBy"],
	Map: ["groupBy"],
	Array: ["fromAsync"],
	Math: ["sumPrecise"],
	RegExp: ["escape"],
	Uint8Array: ["fromBase64", "fromHex"]
}
// Prototype methods by name (no type information): unique enough not to hit the package's own methods.
const hermesMethods = ["toSorted", "toBase64", "toHex", "setFromBase64", "setFromHex", "transferToFixedLength", "getFloat16", "setFloat16"]
const hermesSyntax = [
	...Object.entries(hermesMembers).map(([object, names]) => ({
		selector: `MemberExpression[object.type='Identifier'][object.name='${object}'][property.name=/^(${names.join("|")})$/]${hermesGuard}`,
		message: hermesMessage
	})),
	{
		selector: `MemberExpression[property.name=/^(${hermesMethods.join("|")})$/]${hermesGuard}`,
		message: hermesMessage
	},
	{
		selector: "Literal[regex.flags=/v/]",
		message: "Hermes has no RegExp v flag: use u."
	},
	{
		selector: "NewExpression[callee.name='RegExp'] > Literal.arguments:nth-child(2)[value=/v/]",
		message: "Hermes has no RegExp v flag: use u."
	}
]

// Nothing in the package may depend on a host app.
const appImportPatterns = [
	{
		group: ["@filen/web", "@filen/web/*", "@filen/mobile", "@filen/mobile/*", "@filen/desktop", "@filen/desktop/*"],
		message: "@filen/office is used by the apps, never the other way round."
	}
]

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		ignores: ["node_modules/**/*"]
	},
	{
		files: ["**/*.{ts,tsx}"],
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
			"no-restricted-imports": [
				"error",
				{
					patterns: appImportPatterns
				}
			]
		}
	},
	{
		files: ["src/core/**"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [...coreImportPatterns, ...appImportPatterns]
				}
			],
			"no-restricted-globals": ["error", ...hermesGlobals],
			"no-restricted-syntax": ["error", ...hermesSyntax]
		}
	}
)
