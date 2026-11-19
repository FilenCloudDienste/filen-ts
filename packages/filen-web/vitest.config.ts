import { defineConfig } from "vitest/config"
import { SINGLETONS } from "./vite/singletons"
import { officeFonts } from "./vite/office-fonts-plugin"
import { officeHyphenation } from "./vite/office-hyphenation-plugin"
import { encodingDetectAsset } from "./vite/encoding-detect-plugin"
import { spellcheckAssets } from "./vite/spellcheck-assets-plugin"
import { pdfjsAssets } from "./vite/pdfjs-assets-plugin"
import { threeAssets } from "./vite/three-assets-plugin"
import { ocrAssets } from "./vite/ocr-assets-plugin"
import { mermaidFrameAsset } from "./vite/mermaid-frame-plugin"
import { MUPDF_WASM_ALIAS } from "./vite/mupdf-wasm"
export default defineConfig({
	// virtual:office-fonts (the viewer's font URLs), virtual:office-hyphenation, virtual:spellcheck-assets,
	// virtual:pdfjs-assets, virtual:three-assets, virtual:ocr-assets and virtual:mermaid-frame resolve in tests as in the app.
	plugins: [
		officeFonts(),
		officeHyphenation(),
		spellcheckAssets(),
		encodingDetectAsset(),
		pdfjsAssets(),
		threeAssets(),
		ocrAssets(),
		mermaidFrameAsset()
	],
	// The same single copies the app build resolves (vite.config.ts): tests render @filen/office's components.
	resolve: { alias: [{ find: "@", replacement: new URL("./src", import.meta.url).pathname }, MUPDF_WASM_ALIAS], dedupe: SINGLETONS },
	test: {
		// @testing-library/react registers its auto-cleanup only when a GLOBAL `afterEach` exists
		// (its index.js guards on `typeof afterEach === "function"`). Without this every render/renderHook
		// root stays mounted in document.body for the rest of the file — and a mounted root keeps its
		// store subscriptions live, so a later test's setState re-renders it. That is not hypothetical:
		// it is what made useDriveListboxNavReveal.test.ts fail at 4 of 5 shuffle seeds. Files still
		// import describe/it/expect explicitly; this only adds the hooks RTL looks for.
		globals: true,
		// Most files need no DOM at all. Those that do declare `// @vitest-environment jsdom` per file,
		// which already scopes jsdom to exactly those — a projects/environmentMatchGlobs split was
		// measured and saves nothing over the per-file directives.
		environment: "node",
		// .tsx too: every component in this codebase is .tsx, so a JSX-bearing test file would
		// otherwise be SKIPPED SILENTLY rather than failing.
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["src/tests/setup.ts"],
		// `pool: "threads"` measured -14% wall here and stayed green across 7 of 8 full runs — but the
		// eighth died on an unexpected worker exit that took the whole run with it. Threads share one
		// process, so any file that leaks (this suite still has mounted-root and module-state leaks)
		// raises RSS for every worker at once. A faster run does not buy an intermittent hard crash;
		// revisit once the leaks above are gone. The default `forks` stays.
		// Before each test: clearMocks clears every mock's calls and results, restoreMocks restores
		// `vi.spyOn` spies (so re-spying a method does not hand back the earlier test's spy). Neither
		// resets a `vi.fn()`: an implementation set with mockReturnValue / mockResolvedValue /
		// mockImplementation, and any unconsumed Once queue, survive into the next test. A file whose
		// tests reconfigure a hoisted mock calls `mockReset()` (or `vi.resetAllMocks()`) in its
		// beforeEach and re-arms its defaults there. `mockReset: true` is deliberately not set: it would
		// wipe every mock configured once at module scope or in a vi.mock factory.
		clearMocks: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true
	}
})
