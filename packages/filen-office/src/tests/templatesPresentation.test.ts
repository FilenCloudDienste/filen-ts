import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { bytesSource } from "../core/opc/index"
import { openOdp } from "../core/odp/read/document"
import { openPptx } from "../core/pptx/package"
import { masterGalleryTheme } from "../core/presentation/edit/apply/design"
import { blankOdp } from "../core/templates/odp"
import { blankPptx } from "../core/templates/pptx"
import { FILEN_THEMES } from "../core/templates/themes/catalog"
import { LAYOUT_TYPES } from "../core/templates/themes/pptx"
import { decodeUtf8 } from "../core/xml/index"
import { OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"

// The blank presentations New ▸ Office ▸ Presentation makes, and the 32 Filen theme variants as decks: what they hold,
// that our readers open them as written, and (opt-in) the Open XML SDK on every pptx (no error at all).
// FILEN_OFFICE_OOXML_VALIDATOR / FILEN_OFFICE_DOTNET name the validator; FILEN_OFFICE_TEMPLATES_ODF_OUT a directory every
// .odp is written to for jing (ODF 1.3 RNG) and the ODF validator, as templatesOdf.test.ts does.

const ODF_OUT = process.env["FILEN_OFFICE_TEMPLATES_ODF_OUT"] || undefined
const SDK_MISSING = openXmlSdkMissing()

function partsOf(bytes: Uint8Array): Record<string, string> {
	return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, data]) => [name, decodeUtf8(data)]))
}

const VARIANTS = FILEN_THEMES.flatMap(theme => [0, 1, 2, 3].map(variant => ({ theme, variant })))

describe("blank pptx", () => {
	it("is 16:9 at 13.333 × 7.5 in, one title slide on the plain theme's master with its eleven layouts", async () => {
		const parts = partsOf(await blankPptx({ locale: "de-DE" }))

		expect(parts["ppt/presentation.xml"]).toContain('<p:sldSz cx="12192000" cy="6858000"/>')
		expect(Object.keys(parts).filter(name => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/u.test(name))).toHaveLength(11)
		expect(parts["ppt/slides/slide1.xml"]).toContain('<p:ph type="ctrTitle"/>')
		expect(parts["ppt/slides/slide1.xml"]).toContain('<p:ph type="subTitle" idx="1"/>')
		expect(parts["ppt/slides/slide1.xml"]).toContain('lang="de-DE"')
		expect(parts["ppt/theme/theme1.xml"]).toContain(
			'<a:fontScheme name="Filen filen 1"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/>'
		)
		expect(parts["ppt/theme/theme1.xml"]).toContain('<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>')
	})

	it("is the same bytes every time and holds nothing about the user", async () => {
		const bytes = await blankPptx({ locale: "en-US" })

		expect(await blankPptx({ locale: "en-US" })).toEqual(bytes)
		expect(Object.keys(partsOf(bytes)).some(name => name.startsWith("docProps/"))).toBe(false)
	})

	it("opens as written: the title slide on the Title Slide layout, the layouts by type, Calibri Light titles", async () => {
		const opened = await openPptx(bytesSource(await blankPptx()))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		await opened.parts.parseAll()

		const { deck } = opened
		const slide = deck.nodes.get(deck.slides[0] ?? (0 as never))
		const layout = slide?.parent === undefined ? undefined : deck.nodes.get(slide.parent)

		expect(deck.size).toEqual({ cx: 12_192_000, cy: 6_858_000 })
		expect(deck.layouts.map(ref => deck.nodes.get(ref)?.layoutType)).toEqual([...LAYOUT_TYPES])
		expect(layout?.layoutType).toBe("title")
		expect(slide?.shapes.map(shape => shape.ph?.type)).toEqual(["ctrTitle", "subTitle"])
		expect(opened.parts.theme(deck.nodes.get(deck.masters[0] ?? (0 as never))?.theme?.part ?? "")?.major.latin).toBe("Calibri Light")
	})
})

describe("blank odp", () => {
	it("is 33.867 × 19.05 cm with Calibri declared, its title page on the Filen master", async () => {
		const parts = partsOf(await blankOdp({ locale: "fr-FR" }))

		expect(parts["mimetype"]).toBe("application/vnd.oasis.opendocument.presentation")
		expect(parts["styles.xml"]).toContain('fo:page-width="33.867cm" fo:page-height="19.05cm"')
		expect(parts["styles.xml"]).toContain('<style:font-face style:name="Calibri" svg:font-family="\'Calibri\'"')
		expect(parts["styles.xml"]).toContain('fo:language="fr" fo:country="FR"')
		expect(parts["content.xml"]).toContain('draw:master-page-name="Filen" presentation:presentation-page-layout-name="AL1T0"')
	})

	it("opens as written: one page on its master, a title and a subtitle", async () => {
		const opened = await openOdp(bytesSource(await blankOdp({ locale: "en-US", title: "Quarterly review" })))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const { deck } = opened
		const slide = await opened.parts.slide(deck.slides[0] ?? (0 as never))

		expect(deck.slides).toHaveLength(1)
		expect(deck.size).toEqual({ cx: 12_192_120, cy: 6_858_000 })
		expect(slide.shapes.map(shape => shape.ph?.type)).toEqual(["title", "subTitle"])
		expect(slide.shapes[0]?.text?.paragraphs[0]?.runs.map(run => (run.kind === "r" ? run.text : "")).join("")).toBe("Quarterly review")
	})

	it("names its master page as the Filen theme and variant it is, so the Design tab offers its variants", async () => {
		const bytes = await blankOdp({ locale: "en-US" })
		const opened = await openOdp(bytesSource(bytes))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const master = opened.deck.nodes.get(opened.deck.masters[0] ?? (0 as never))

		expect(master === undefined ? undefined : masterGalleryTheme(opened.deck, master)).toEqual({ id: "filen", variant: 0 })
		expect(partsOf(bytes)["styles.xml"]).toContain('style:display-name="Filen filen 1"')
	})
})

describe("the Filen themes", () => {
	it("are eight themes of four variants in the ORCH-8 font names, each dark variant mapping its background to dk1", async () => {
		expect(FILEN_THEMES.map(theme => theme.id)).toEqual([
			"filen",
			"slate",
			"harbor",
			"ember",
			"meadow",
			"ledger",
			"studio",
			"typewriter"
		])

		const fonts = new Set(["Calibri", "Calibri Light", "Cambria", "Arial", "Times New Roman", "Courier New", "Georgia", "Segoe UI"])

		for (const { theme, variant } of VARIANTS) {
			const parts = partsOf(await blankPptx({ theme, variant }))
			const dark = theme.variants[variant]?.dark === true

			expect(fonts.has(theme.major) && fonts.has(theme.minor)).toBe(true)
			expect(parts["ppt/theme/theme1.xml"]).toContain(`name="Filen ${theme.id} ${String(variant + 1)}"`)
			expect(parts["ppt/slideMasters/slideMaster1.xml"]).toContain(dark ? 'bg1="dk1" tx1="lt1"' : 'bg1="lt1" tx1="dk1"')
		}
	})
})

describe.skipIf(SDK_MISSING !== undefined)("Filen decks under the Open XML SDK validator", () => {
	let sdk: OpenXmlSdk
	let scratch: string

	beforeAll(() => {
		sdk = new OpenXmlSdk()
		scratch = mkdtempSync(join(tmpdir(), "filen-office-presentation-templates-"))
	})

	afterAll(async () => {
		await sdk.close()
		rmSync(scratch, { recursive: true, force: true })
	})

	it("the blank template and every theme variant have no error", { timeout: 120_000 }, async () => {
		const decks: [string, Uint8Array][] = [["blank.pptx", await blankPptx({ locale: "en-GB" })]]

		for (const { theme, variant } of VARIANTS)
			decks.push([`${theme.id}-${String(variant)}.pptx`, await blankPptx({ theme, variant, title: theme.id })])

		for (const [name, bytes] of decks) {
			const path = join(scratch, name)

			writeFileSync(path, bytes)
			expect([...sdkErrorCounts(await sdk.validate(path))], name).toEqual([])
		}
	})
})

describe.skipIf(ODF_OUT === undefined)("Filen decks for the ODF validators", () => {
	it("writes the blank template and every theme variant as .odp", async () => {
		const out = ODF_OUT ?? ""

		mkdirSync(out, { recursive: true })
		writeFileSync(join(out, "blank.odp"), await blankOdp({ locale: "en-US" }))

		for (const { theme, variant } of VARIANTS)
			writeFileSync(
				join(out, `${theme.id}-${String(variant)}.odp`),
				await blankOdp({ locale: "en-US", theme, variant, title: theme.id })
			)
	})
})
