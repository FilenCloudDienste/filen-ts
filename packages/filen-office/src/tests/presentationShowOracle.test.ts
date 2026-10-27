import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ShowSettings } from "../core/presentation/model"
import { convertWith, offices } from "./interop/soffice"
import { ODP_DECK, openOdpDeck } from "./odpWriteFixtures"
import { odpBytes } from "./odpFixtures"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { DEFAULTS, pptxBytes, savedOdpShow, savedPptxShow, SOURCE_SHOW_PR } from "./showSettingsFixtures"

// Set Up Slide Show saves against external oracles, each opt-in and skipped when unset:
// - FILEN_OFFICE_OOXML_VALIDATOR (with FILEN_OFFICE_DOTNET): no saved pptx has an Open XML SDK error its source does not;
// - FILEN_OFFICE_ODFVALIDATOR=<odfvalidator jar>: no saved ODP has an error its source does not;
// - FILEN_OFFICE_SOFFICE naming a 7.5 install: LibreOffice reads each saved pptx's settings as we wrote them (what its
//   ODF can hold), and keeps each saved ODP's through its own round trip.
// Files go under FILEN_OFFICE_SHOW_SCRATCH (default: a new temp directory); FILEN_OFFICE_LO_PROFILE names the
// LibreOffice profile directory (default: one in the scratch directory).

const SDK_MISSING = openXmlSdkMissing()
const ODF_VALIDATOR = process.env["FILEN_OFFICE_ODFVALIDATOR"] ?? ""
const OFFICE = offices().find(office => office.version.startsWith("7.5."))

const PPTX_CASES: readonly ShowSettings[] = [
	{ ...DEFAULTS, kind: "kiosk", loop: true, restartMs: 60_000, showNarration: true, penColor: { kind: "preset", name: "red" } },
	{
		...DEFAULTS,
		kind: "browse",
		useTimings: false,
		showAnimation: false,
		showNarration: true,
		penColor: { kind: "srgb", rgb: "00FF00" }
	},
	{ ...DEFAULTS, range: { kind: "range", start: 2, end: 4 }, loop: true },
	{ ...DEFAULTS, range: { kind: "customShow", id: 0 } }
]

const ODP_CASES: readonly ShowSettings[] = [
	{ ...DEFAULTS, loop: true, restartMs: 10_000, useTimings: false },
	{ ...DEFAULTS, kind: "browse", showAnimation: false, range: { kind: "range", start: 2, end: 3 } },
	{ ...DEFAULTS, range: { kind: "customShow", id: 0 } }
]

describe.skipIf(SDK_MISSING !== undefined && ODF_VALIDATOR === "" && OFFICE === undefined)(
	"Set Up Slide Show saves against the oracles",
	() => {
		let scratch: string
		const pptxFiles: string[] = []
		const odpFiles: string[] = []
		let pptxSource = ""
		let odpSource = ""

		beforeAll(async () => {
			const root = process.env["FILEN_OFFICE_SHOW_SCRATCH"]

			if (root !== undefined && root !== "") mkdirSync(root, { recursive: true })

			scratch = mkdtempSync(join(root !== undefined && root !== "" ? root : tmpdir(), "filen-office-show-"))
			pptxSource = join(scratch, "source.pptx")
			odpSource = join(scratch, "source.odp")
			writeFileSync(pptxSource, pptxBytes(SOURCE_SHOW_PR))
			writeFileSync(odpSource, odpBytes(ODP_DECK))

			for (const [index, show] of PPTX_CASES.entries()) {
				const file = join(scratch, `saved${String(index)}.pptx`)

				writeFileSync(file, (await savedPptxShow(pptxBytes(SOURCE_SHOW_PR), show)).bytes)
				pptxFiles.push(file)
			}

			const bare = join(scratch, `saved${String(PPTX_CASES.length)}.pptx`)

			writeFileSync(bare, (await savedPptxShow(pptxBytes(undefined), { ...DEFAULTS, kind: "kiosk", restartMs: 1000 })).bytes)
			pptxFiles.push(bare)

			for (const [index, show] of ODP_CASES.entries()) {
				const file = join(scratch, `saved${String(index)}.odp`)

				writeFileSync(file, (await savedOdpShow(odpBytes(ODP_DECK), show)).bytes)
				odpFiles.push(file)
			}
		}, 120_000)

		afterAll(() => {
			rmSync(scratch, { recursive: true, force: true })
		})

		it.skipIf(SDK_MISSING !== undefined)("adds no Open XML SDK error to a saved pptx", { timeout: 300_000 }, async () => {
			const sdk = new OpenXmlSdk()
			const allow = loadAllowlist()

			try {
				const before = sdkErrorCounts(await sdk.validate(pptxSource))

				for (const file of pptxFiles)
					expect(newSdkErrors(before, sdkErrorCounts(await sdk.validate(file)), allow), basename(file)).toEqual([])
			} finally {
				await sdk.close()
			}
		})

		it.skipIf(ODF_VALIDATOR === "")("adds no odfvalidator error to a saved ODP", { timeout: 300_000 }, () => {
			const errors = (file: string): Set<string> => {
				const run = spawnSync("java", ["-jar", ODF_VALIDATOR, "-1.3", file], { encoding: "utf8", maxBuffer: 1 << 26 })
				const out = new Set<string>()

				for (const line of `${run.stdout}\n${run.stderr}`.split("\n")) {
					const match = /^.+?\.odp(\/[^[:]*)?(?:\[\d+,\d+\])?:\s+(?:Error|Fatal):\s+(.*)$/u.exec(line)

					if (match !== null) out.add(`${match[1] ?? ""}: ${match[2] ?? ""}`)
				}

				return out
			}
			const before = errors(odpSource)

			for (const file of odpFiles)
				expect(
					[...errors(file)].filter(error => !before.has(error)),
					basename(file)
				).toEqual([])
		})

		it.skipIf(OFFICE === undefined)("LibreOffice reads each saved file's settings as written", { timeout: 600_000 }, async () => {
			const office = OFFICE as NonNullable<typeof OFFICE>
			const profile = process.env["FILEN_OFFICE_LO_PROFILE"] || join(scratch, "lo-profile")
			const out = join(scratch, "lo")
			const pptx = await convertWith(office, profile, "odp:impress8", pptxFiles, join(out, "fromPptx"), 120_000)
			const odp = await convertWith(office, profile, "odp:impress8", odpFiles, join(out, "fromOdp"), 120_000)

			expect(pptx.timedOut || odp.timedOut).toBe(false)

			// What LibreOffice's ODF holds of a pptx show: looping, manual advance, the range's start, the custom show.
			for (const [index, file] of pptxFiles.entries()) {
				const show = PPTX_CASES[index] ?? { ...DEFAULTS, kind: "kiosk" as const, restartMs: 1000 }
				const converted = join(out, "fromPptx", basename(file).replace(/\.pptx$/u, ".odp"))

				expect(existsSync(converted), basename(file)).toBe(true)

				const read = (await openOdpDeck(new Uint8Array(readFileSync(converted)), false)).deck.show

				expect({ loop: read.loop, useTimings: read.useTimings, range: read.range }, basename(file)).toEqual({
					loop: show.loop,
					useTimings: show.useTimings,
					range: show.range
				})
			}

			for (const [index, file] of odpFiles.entries()) {
				const converted = join(out, "fromOdp", basename(file))
				const read = (await openOdpDeck(new Uint8Array(readFileSync(converted)), false)).deck.show

				expect(read, basename(file)).toEqual(ODP_CASES[index])
			}
		})
	}
)
