import { strToU8, unzipSync, zipSync } from "fflate"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CORPUS_DIR } from "../corpusDir"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, SDK_EXTENSIONS, sdkErrorCounts, sdkPackageKind } from "./openXmlSdk"

// The Open XML SDK validator on PresentationML packages. Opt-in: FILEN_OFFICE_OOXML_VALIDATOR names the built
// validator, FILEN_OFFICE_DOTNET the dotnet host; the extension checks run without them.

const PROGRAM = new URL("../../../tools/openxml-validate/Program.cs", import.meta.url)
const MISSING = openXmlSdkMissing()
const DECK = join(CORPUS_DIR, "pptx", "govuk__Ofqual_GCSE_A_level_grading_lesson_plan_slides.pptx")

function programExtensions(name: string): string[] {
	const match = new RegExp(`string\\[\\] ${name} = \\[([^\\]]*)\\]`).exec(readFileSync(PROGRAM, "utf8"))

	return [...(match?.[1] ?? "").matchAll(/"\.(\w+)"/g)].map(found => found[1] ?? "")
}

describe("the validator's package kinds", () => {
	it("lists the extensions Program.cs opens as presentations and spreadsheets", () => {
		expect(programExtensions("presentationExtensions")).toEqual([...SDK_EXTENSIONS.presentation])
		expect(programExtensions("spreadsheetExtensions")).toEqual([...SDK_EXTENSIONS.spreadsheet])
	})

	it("names the kind a path opens as, case-insensitively, and none for other formats", () => {
		expect(sdkPackageKind("a/Deck.PPSM")).toBe("presentation")
		expect(sdkPackageKind("b.xltx")).toBe("spreadsheet")
		expect(sdkPackageKind("c.dotm")).toBe("wordprocessing")
		expect(sdkPackageKind("d.ppt")).toBeUndefined()
		expect(sdkPackageKind("e.odp")).toBeUndefined()
	})
})

describe.skipIf(MISSING !== undefined || !existsSync(DECK))("PresentationML against the Open XML SDK validator", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-openxml-presentation-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("opens a corpus deck under every presentation extension", { timeout: 120_000 }, async () => {
		const bytes = readFileSync(DECK)

		for (const extension of SDK_EXTENSIONS.presentation) {
			const copy = join(scratch, `deck.${extension}`)

			writeFileSync(copy, bytes)

			const result = await sdk.validate(copy)

			expect(result.fatal, extension).toBeUndefined()
			expect(result.errors, extension).toEqual([])
		}
	})

	it("counts only the errors a changed copy adds to its source", { timeout: 120_000 }, async () => {
		const entries = unzipSync(new Uint8Array(readFileSync(DECK)))
		const slide = entries["ppt/slides/slide1.xml"]

		expect(slide).toBeDefined()

		// A shape id must be an unsigned integer.
		const text = new TextDecoder().decode(slide).replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="not-a-number"')

		entries["ppt/slides/slide1.xml"] = strToU8(text)

		const changed = join(scratch, "changed.pptx")

		writeFileSync(changed, zipSync(entries))

		const allow = loadAllowlist()
		const source = sdkErrorCounts(await sdk.validate(DECK))
		const after = sdkErrorCounts(await sdk.validate(changed))

		expect(newSdkErrors(source, source, allow)).toEqual([])

		const added = newSdkErrors(source, after, allow)

		expect(added.length).toBeGreaterThan(0)
		expect(added.every(key => key.startsWith("/ppt/slides/slide1.xml "))).toBe(true)
	})
})
