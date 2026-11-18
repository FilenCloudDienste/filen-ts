import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

// Mermaid runs only in the diagram frame: the frame's script is the one module that imports it by value (it is built on
// its own, vite/mermaid-frame-plugin.ts), so the page's bundle never holds it. Everything else takes its types only.

const WEB_SRC = join(import.meta.dirname, "..")
const FRAME_ENTRY = "mermaidFrame/entry.ts"
const VALUE_IMPORT =
	/^\s*(?:import|export)\s+(?!type\b)(?:(?!\bfrom\s+["'])[\s\S])*?\bfrom\s+["']mermaid(?:\/[^"']*)?["']|import\(\s*["']mermaid(?:\/[^"']*)?["']/m

describe("mermaid stays out of the page bundle", { timeout: 60_000 }, () => {
	it("is imported by value from the frame's script alone", () => {
		const importers = readdirSync(WEB_SRC, { recursive: true, encoding: "utf8" })
			.filter(path => /\.tsx?$/.test(path) && !/(^|\/)tests\//.test(path))
			.filter(path => VALUE_IMPORT.test(readFileSync(join(WEB_SRC, path), "utf8")))
			.map(path => relative(WEB_SRC, join(WEB_SRC, path)))

		expect(importers).toEqual([FRAME_ENTRY])
	})
})
