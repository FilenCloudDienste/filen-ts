import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// Both wasm modules ship in the same web bundle and share one CI cargo cache: their crates build with the same
// pinned toolchain. The files' leading comments may differ; the [toolchain] table may not.
function toolchainTable(packageName: string): string {
	const text = readFileSync(new URL(`../../../${packageName}/rust-toolchain.toml`, import.meta.url), "utf8")
	const start = text.indexOf("[toolchain]")

	if (start === -1) {
		throw new Error(`${packageName}/rust-toolchain.toml has no [toolchain] table`)
	}

	return text.slice(start).trim()
}

describe("rust-toolchain.toml", () => {
	it("pins the same toolchain as @filen/spellcheck", () => {
		const own = toolchainTable("filen-encoding-detect")

		expect(own).toMatch(/^channel = "[^"]+"$/m)
		expect(own).toBe(toolchainTable("filen-spellcheck"))
	})
})
