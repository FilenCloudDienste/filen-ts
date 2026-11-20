import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"

const PACKAGE_ROOT = new URL("../..", import.meta.url).pathname

describe("emojiData.gen.ts", () => {
	it("is what scripts/emojiData.ts generates from the installed emojibase-data (re-run it after a bump)", () => {
		expect(() =>
			execFileSync(process.execPath, ["--import", "tsx", "scripts/emojiData.ts", "--check"], { cwd: PACKAGE_ROOT, stdio: "pipe" })
		).not.toThrow()
	}, 30_000)
})
