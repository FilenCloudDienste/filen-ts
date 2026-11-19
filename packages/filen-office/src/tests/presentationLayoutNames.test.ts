import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { galleryThemeOp } from "../core/presentation/edit/commands/design"
import { designLayouts } from "../core/presentation/edit/apply/design"
import { blankOdp } from "../core/templates/odp"
import { blankPptxParts } from "../core/templates/pptx"
import type { TemplatePart } from "../core/templates/zip"
import { openOdpDeck } from "./odpWriteFixtures"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { partsOf, rebaseSession, saveEdits, text } from "./pptxWriteFixtures"
import { designDeck } from "./presentationDesignFixtures"

// The layouts of a deck Filen makes (New ▸ Presentation, a gallery theme) carry the names the caller gives, in the
// user's language, through every part that makes them: the template, the theme applied, a variant and the saves.

const GERMAN = { title: "Titelfolie", obj: "Titel und Inhalt", blank: "Leer" }

async function run(h: EditHarness, op: DeckOp): Promise<number> {
	const result = await h.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)

	return result.revision
}

function cSldName(markup: string | Uint8Array | undefined): string | undefined {
	return /<p:cSld name="([^"]*)"/u.exec(typeof markup === "string" ? markup : text(markup))?.[1]
}

function partMap(parts: readonly TemplatePart[]): Map<string, string> {
	return new Map(parts.map(([name, markup]) => [name, markup]))
}

// The names of the layouts on the deck's last master, by type.
function lastMasterNames(h: EditHarness): Record<string, string | undefined> {
	const deck = h.session.deck
	const master = deck.masters.at(-1)
	const out: Record<string, string | undefined> = {}

	for (const ref of deck.layouts) {
		const layout = deck.nodes.get(ref)

		if (layout?.parent === master && layout?.layoutType !== undefined) out[layout.layoutType] = layout.name
	}

	return out
}

describe("layout names in the user's language", () => {
	it("writes the given names into the template's layouts, English for the types without one, escaped", () => {
		const parts = partMap(blankPptxParts({ layoutNames: { ...GERMAN, twoObj: "Zwei & mehr" } }))

		expect(cSldName(parts.get("ppt/slideLayouts/slideLayout1.xml"))).toBe("Titelfolie")
		expect(cSldName(parts.get("ppt/slideLayouts/slideLayout2.xml"))).toBe("Titel und Inhalt")
		expect(cSldName(parts.get("ppt/slideLayouts/slideLayout3.xml"))).toBe("Section Header")
		expect(cSldName(parts.get("ppt/slideLayouts/slideLayout4.xml"))).toBe("Zwei &amp; mehr")
		expect(cSldName(parts.get("ppt/slideLayouts/slideLayout7.xml"))).toBe("Leer")
		expect(cSldName(partMap(blankPptxParts()).get("ppt/slideLayouts/slideLayout1.xml"))).toBe("Title Slide")
	})

	it("names a gallery theme's layouts with the op's names, and keeps them through a save, a resize and a variant", async () => {
		const bytes = await designDeck(["title", "obj"])
		const h = await editHarness(bytes)
		const revision = await run(h, galleryThemeOp("slate", 0, h.session.deck.slides, GERMAN))

		expect(lastMasterNames(h)).toMatchObject({ title: "Titelfolie", obj: "Titel und Inhalt", blank: "Leer", secHead: "Section Header" })

		const first = await saveEdits(h, revision)
		const firstParts = await partsOf(first)
		const named = [...firstParts].filter(([name]) => /^ppt\/slideLayouts\/[^/]+\.xml$/u.test(name)).map(([, part]) => cSldName(part))

		expect(named.filter(name => name === "Titelfolie")).toHaveLength(1)
		expect(named.filter(name => name === "Title Slide")).toHaveLength(1)

		// A size change makes the saved gallery master's layouts again (emit/design.ts rewriteGallery).
		await rebaseSession(h, bytes, first)

		const resized = await saveEdits(
			h,
			await run(h, { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" })
		)
		const resizedNames = [...(await partsOf(resized))]
			.filter(([name]) => /^ppt\/slideLayouts\/[^/]+\.xml$/u.test(name))
			.map(([, part]) => cSldName(part))

		expect(resizedNames.filter(name => name === "Titelfolie")).toHaveLength(1)
		expect(resizedNames.filter(name => name === "Leer")).toHaveLength(1)

		const master = h.session.deck.masters.at(-1)

		if (master === undefined) throw new Error("no master")

		await run(h, { family: "design", kind: "setVariant", master, variant: 2 })
		expect(lastMasterNames(h)).toMatchObject({ title: "Titelfolie", obj: "Titel und Inhalt", blank: "Leer" })
		h.close()
	})

	it("leaves an ODP deck's layouts unnamed (the page layouts have none), so the editor shows them by type", async () => {
		const opened = await openOdpDeck(await blankOdp({ locale: "de-DE" }))
		const layouts = designLayouts(opened.deck)

		expect(layouts.length).toBeGreaterThan(0)
		expect(layouts.every(layout => layout.name === undefined && layout.type !== undefined)).toBe(true)
	})
})
