import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readRtf } from "../core/rtf/index"
import { CORPUS_DIR } from "./corpusDir"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"

// The RTF writer's saves (FILEN_OFFICE_RTF_WRITE_OUT, written by rtfWriterCorpus.test.ts) read into packages
// that the Open XML SDK validator finds no error in beyond those of the original file's own package. Opt-in:
// needs the validator (oracles/openXmlSdk.ts) and the saves.

const OUT = process.env["FILEN_OFFICE_RTF_WRITE_OUT"] || undefined
const MISSING = openXmlSdkMissing()
const ENABLED = MISSING === undefined && OUT !== undefined && existsSync(OUT) && existsSync(join(CORPUS_DIR, "rtf"))

async function translation(bytes: Uint8Array): Promise<Uint8Array> {
	const read = await readRtf(bytes)

	if (!read.ok) throw new Error(read.reason)

	return read.docx
}

describe.skipIf(!ENABLED)("RTF writer saves against the Open XML SDK", () => {
	it("reads every save into a package with no validator error the original's has not", { timeout: 1_800_000 }, async () => {
		const sdk = new OpenXmlSdk()
		const scratch = mkdtempSync(join(tmpdir(), "rtf-sdk-"))
		const allow = loadAllowlist()
		const report: { name: string; errors: number; originalErrors: number; added: string[] }[] = []

		try {
			for (const name of readdirSync(OUT as string)
				.filter(file => file.toLowerCase().endsWith(".rtf"))
				.sort()) {
				const saved = join(scratch, "saved.docx")
				const original = join(scratch, "original.docx")

				writeFileSync(saved, await translation(new Uint8Array(readFileSync(join(OUT as string, name)))))
				writeFileSync(original, await translation(new Uint8Array(readFileSync(join(CORPUS_DIR, "rtf", name)))))

				const after = sdkErrorCounts(await sdk.validate(saved))
				const before = sdkErrorCounts(await sdk.validate(original))
				const count = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, value) => sum + value, 0)

				report.push({ name, errors: count(after), originalErrors: count(before), added: newSdkErrors(before, after, allow) })
			}
		} finally {
			await sdk.close()
			rmSync(scratch, { recursive: true, force: true })
		}

		writeFileSync(join(OUT as string, "sdk.json"), JSON.stringify(report, null, "\t"))

		expect(report.length).toBeGreaterThan(0)
		expect(report.filter(entry => entry.added.length > 0)).toEqual([])
	})
})
