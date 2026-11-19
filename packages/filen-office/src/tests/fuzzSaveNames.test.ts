import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildDocx, p } from "./docxSynthetic"
import { summarizeDocument, writeManifest, writeSave, type ManifestEntry, type SaveInput } from "./fuzz/saves"

// Kept fuzz saves of corpus files that share a stem (docm/x.docm and dotm/x.dotm) keep a save and a sidecar each,
// and the manifest lists both.

describe("fuzz save names", () => {
	let dir = ""

	afterEach(() => {
		if (dir !== "") rmSync(dir, { recursive: true, force: true })
	})

	it("keeps a save and a sidecar per source extension", async () => {
		dir = mkdtempSync(join(tmpdir(), "filen-office-fuzz-saves-"))

		const bytes = buildDocx({ body: p("text") })
		const config = { dir, every: 1, maxBytes: 5_000_000 }
		const input = (source: string): SaveInput => ({
			source,
			sourceBytes: bytes,
			family: "docx",
			harness: "damage",
			mode: "stories",
			seed: 7,
			n: 0,
			view: "final",
			endView: "final",
			ops: [],
			changedParts: [],
			bytes
		})
		const before = (): ReturnType<typeof summarizeDocument> => summarizeDocument(bytes)

		expect(await writeSave(config, input("docm/oxsdk__Macro.docm"), before)).toBe(true)
		expect(await writeSave(config, input("dotm/oxsdk__Macro.dotm"), before)).toBe(true)

		const files = readdirSync(join(dir, "docx")).sort()

		expect(files.filter(name => name.endsWith(".json"))).toHaveLength(2)
		expect(files.filter(name => name.endsWith(".part"))).toEqual([])
		expect(writeManifest(dir)).toBe(2)

		const entries = (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { entries: ManifestEntry[] }).entries

		expect(entries.map(entry => entry.source).sort()).toEqual(["docm/oxsdk__Macro.docm", "dotm/oxsdk__Macro.dotm"])

		for (const entry of entries) {
			expect(existsSync(join(dir, entry.path))).toBe(true)
			expect(existsSync(join(dir, entry.sidecar))).toBe(true)
			// The real extension stays last: LibreOffice picks its import filter from it.
			expect(entry.path.endsWith(entry.source.slice(entry.source.lastIndexOf(".")))).toBe(true)
		}
	})
})
