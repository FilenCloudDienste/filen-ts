import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { CODE_PHRASES } from "../dom/code/setup"

// The CodeMirror packages whose extensions the code editors install, which read their labels through state.phrase.
const PHRASE_PACKAGES = ["view", "language", "search", "merge", "autocomplete", "commands", "lint"] as const

describe("CODE_PHRASES", () => {
	// An upgrade that adds, rewords or drops a phrase fails here, so an app's phrase map never falls behind.
	it("lists exactly the phrases the installed CodeMirror extensions read", () => {
		const require = createRequire(import.meta.url)
		const read = new Set<string>()

		for (const name of PHRASE_PACKAGES) {
			const source = readFileSync(require.resolve(`@codemirror/${name}`), "utf8")

			for (const call of source.matchAll(/\bphrase\(([^;]*?)\)/g)) {
				for (const literal of (call[1] ?? "").matchAll(/"([^"]+)"/g)) {
					read.add(literal[1] ?? "")
				}
			}
		}

		expect([...read].sort()).toEqual([...CODE_PHRASES].sort())
	})
})
