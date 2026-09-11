import { defineConfig } from "vitest/config"
export default defineConfig({
	resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
	test: {
		// @testing-library/react registers its auto-cleanup only when a GLOBAL `afterEach` exists
		// (its index.js guards on `typeof afterEach === "function"`). Without this every render/renderHook
		// root stays mounted in document.body for the rest of the file — and a mounted root keeps its
		// store subscriptions live, so a later test's setState re-renders it. That is not hypothetical:
		// it is what made useDriveListboxNavReveal.test.ts fail at 4 of 5 shuffle seeds. Files still
		// import describe/it/expect explicitly; this only adds the hooks RTL looks for.
		globals: true,
		// 238 of 282 files need no DOM at all. The 44 that do declare `// @vitest-environment jsdom`
		// per file, which already scopes jsdom to exactly those — a projects/environmentMatchGlobs
		// split was measured and saves nothing over the per-file directives.
		environment: "node",
		// .tsx too: every component in this codebase is .tsx, so a JSX-bearing test file would
		// otherwise be SKIPPED SILENTLY rather than failing.
		include: ["src/**/*.test.{ts,tsx}"],
		// `pool: "threads"` measured -14% wall here and stayed green across 7 of 8 full runs — but the
		// eighth died on an unexpected worker exit that took the whole run with it. Threads share one
		// process, so any file that leaks (this suite still has mounted-root and module-state leaks)
		// raises RSS for every worker at once. A second off a six-second suite does not buy an
		// intermittent hard crash; revisit once the leaks above are gone. The default `forks` stays.
		// The three isolation guarantees the suite was written as if it had. `vi.clearAllMocks()` only
		// calls mockClear, so without these a spy stays installed, an implementation stays live, and an
		// unconsumed `mockResolvedValueOnce` queue survives into the next test — and re-spying an
		// already-spied method hands back the SAME spy with the earlier test's calls still recorded.
		// Correctness here used to depend on file order, test order, and nobody reordering anything.
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true
	}
})
