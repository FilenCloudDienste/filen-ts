import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import globals from "globals"
import { defineConfig, globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier/flat"

const ALIAS_ONLY = {
	group: ["./*", "../*"],
	message: 'Use the "@/..." alias instead of a relative import.'
}

// Mediabunny demuxes and muxes on whichever thread imports it, and it is large: only the remux worker runs it,
// so the main thread and the other workers neither parse it nor block on its work.
const MEDIABUNNY_REMUX_ONLY = {
	group: ["mediabunny", "mediabunny/**", "@mediabunny/*", "@mediabunny/**"],
	message: "Mediabunny runs only in the remux worker (src/workers/remux.worker.ts, src/workers/remux/**); talk to that worker instead."
}

// Everything ships in one bundle (codeSplitting: false). Shared by the app-wide block and the assistant's, which
// replaces the rule: an eager import.meta.glob would otherwise reach past the assistant's import restrictions.
const NO_LAZY_LOADING = [
	{
		selector: "CallExpression[callee.name='lazy'], CallExpression[callee.property.name='lazy']",
		message: "No lazy-loaded components; import statically."
	},
	{
		selector: "ImportSpecifier[imported.name=/^(lazyRouteComponent|createLazyRoute|createLazyFileRoute)$/]",
		message: "No lazy routes; define the route component statically."
	},
	{
		selector: "MemberExpression[object.meta.name='import'][property.name='glob']",
		message: "import.meta.glob defaults to lazy imports; import statically."
	}
]

const ASSISTANT_FORBIDDEN =
	"The assistant acts on model output that text other people wrote can steer, so it never reaches irreversible or security-critical operations."

const ASSISTANT_RAW_SDK = "The assistant goes through the feature modules the user's own actions use, never the raw SDK."

// The assistant's dispatcher runs calls a model produced, and a shared note or chat message can
// steer that model. What the assistant can import it may one day call, so permanent deletion,
// restoring from the trash or a version, sending, sharing, public links, adding participants, every
// contact action, leaving, unsharing, account security, the session, logout and stopping or pausing
// transfers are kept out of its reach at the import level, whatever the guard decides at runtime.
// Chats are draft-only: nothing that sends, queues or drops a message. The trash, transfers and settings it only reads or opens.
const ASSISTANT_RESTRICTED_PATHS = [
	{
		name: "@/features/drive/lib/actions",
		importNames: [
			"deleteItemsPermanently",
			"emptyTrash",
			"restoreItems",
			"restoreVersion",
			"deleteVersion",
			"deleteVersions",
			"createLink",
			"updateLink",
			"disableLink",
			"disableLinks"
		],
		message: ASSISTANT_FORBIDDEN
	},
	{ name: "@/features/drive/lib/share/actions", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/notes/lib/actions", importNames: ["deleteNote", "leaveNote", "restoreNote"], message: ASSISTANT_FORBIDDEN },
	{
		name: "@/features/notes/lib/bulk",
		importNames: ["deleteNotesPermanently", "leaveNotes", "restoreNotes"],
		message: ASSISTANT_FORBIDDEN
	},
	// Restoring a note's older version overwrites its current text.
	{ name: "@/features/notes/lib/history", importNames: ["restoreNoteFromHistory"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/notes/lib/tags", importNames: ["deleteNoteTag"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/notes/lib/participants", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/actions", importNames: ["deleteChat", "leaveChat"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/bulk", importNames: ["deleteChatsPermanently", "leaveChats"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/sync", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/messageActions", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/drafts", importNames: ["deleteDraft"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/participants", message: ASSISTANT_FORBIDDEN },
	// The outbox sends what is queued (a retry, an enqueued message), purging drops unsent messages for good,
	// and a trusted domain silences the link warning in every chat.
	{ name: "@/features/chats/lib/inflight", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/outboxCoordinator", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/trustedDomains", message: ASSISTANT_FORBIDDEN },
	{ name: "@/lib/trustedLinks/trustedDomains", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/lib/attachments", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/chats/store/useChatsInflight", allowTypeImports: true, message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/audio/lib/playlists", importNames: ["deletePlaylistAction"], message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/contacts/lib/actions", message: ASSISTANT_FORBIDDEN },
	// requestJobCancel's "trash" mode deletes what a job already wrote; a stopped transfer loses its progress.
	{ name: "@/features/transfers/lib/control", message: ASSISTANT_FORBIDDEN },
	{
		name: "@/lib/sdk/session",
		importNames: ["persistSession", "clearSession", "resumeSession", "broadcastAuth"],
		message: ASSISTANT_FORBIDDEN
	},
	{ name: "@/lib/logout", message: ASSISTANT_FORBIDDEN },
	{ name: "@/features/shell/lib/performLogout", message: ASSISTANT_FORBIDDEN },
	{ name: "@/lib/sdk/client", message: ASSISTANT_RAW_SDK },
	{ name: "@/workers/sdk.worker", allowTypeImports: true, message: ASSISTANT_RAW_SDK },
	{ name: "@filen/sdk-rs", allowTypeImports: true, message: ASSISTANT_RAW_SDK }
]

const ASSISTANT_RESTRICTED_PATTERNS = [
	ALIAS_ONLY,
	MEDIABUNNY_REMUX_ONLY,
	{
		// Settings are opened, never changed.
		group: ["@/features/settings/**", "@/features/auth/**", "@/e2e-hooks", "@/e2e-hooks/**"],
		message: ASSISTANT_FORBIDDEN
	}
]

export default defineConfig([
	globalIgnores([
		"dist",
		"docs",
		"src/routeTree.gen.ts",
		"src/lib/sdk/errorKinds.gen.ts",
		"src/features/settings/thirdPartyNotices.gen.ts"
	]),
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
		// rootRedirect.ts is the same shape for "/": its beforeLoad body is split out so the redirect
		// switch itself is unit-testable without a router instance (see rootRedirect.test.ts).
		files: ["src/features/auth/lib/guard.ts", "src/features/shell/lib/rootRedirect.ts"],
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
			"no-restricted-imports": ["error", { patterns: [ALIAS_ONLY, MEDIABUNNY_REMUX_ONLY] }]
		}
	},
	{
		// The remux worker and its modules run Mediabunny; tests exercise them directly.
		files: ["src/workers/remux.worker.ts", "src/workers/remux/**/*.{ts,tsx}", "src/tests/**/*.{ts,tsx}"],
		rules: {
			"no-restricted-imports": ["error", { patterns: [ALIAS_ONLY] }]
		}
	},
	{
		// Everything ships in one bundle (codeSplitting: false), so a dynamic import only adds an async
		// hop and hides import cycles. The env-gated e2e hooks are dead-code-eliminated from normal builds.
		files: ["src/**/*.{ts,tsx}"],
		ignores: ["src/tests/**"],
		rules: {
			"no-restricted-syntax": [
				"error",
				{
					selector: "ImportExpression:not([source.value='@/e2e-hooks'])",
					message: "No dynamic imports in app code; import statically."
				},
				...NO_LAZY_LOADING
			]
		}
	},
	{
		// The typescript-eslint variant, because types from the SDK are fine and its values are not. An
		// import() expression is invisible to both import rules, so it is refused outright.
		files: ["src/features/assistant/**/*.{ts,tsx}", "src/workers/assistant.worker.ts"],
		rules: {
			"no-restricted-imports": "off",
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{ paths: ASSISTANT_RESTRICTED_PATHS, patterns: ASSISTANT_RESTRICTED_PATTERNS }
			],
			"no-restricted-syntax": [
				"error",
				{ selector: "ImportExpression", message: "A dynamic import would slip past the assistant's import restrictions." },
				...NO_LAZY_LOADING
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
	{
		// Ribbon group files export their `<tab>Groups` function (the tabs.ts registry contract) beside the
		// components it renders.
		files: ["src/features/presentation/components/ribbon/*.tsx"],
		rules: {
			"react-refresh/only-export-components": "off"
		}
	},
	// Must stay last — turns off stylistic rules that would otherwise fight prettier's output.
	eslintConfigPrettier
])
