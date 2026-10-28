import { describe, expect, it } from "vitest"
import { openPptx } from "../core/pptx/package"
import { bytesSource } from "../core/opc/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideNode } from "../core/presentation/model"
import { FILEN_THEMES } from "../core/templates/themes/catalog"
import { editHarness, type EditHarness } from "./presentationEditFixtures"
import { danglingReferences, partsOf, rebaseSession, saveEdits, text } from "./pptxWriteFixtures"
import { designDeck, designOdp } from "./presentationDesignFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf } from "./odpWriteFixtures"
import { viewCapability } from "../dom/presentation/engine/view"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { designInfo } from "../core/presentation/edit/apply/design"

// The design family on a pptx session: a gallery theme applied (a new master with its layouts, every slide moved by
// layout type, slide parts untouched but for their relationships), the file's own theme applied back, variants,
// slide size and backgrounds, each saved and undone.

async function run(h: EditHarness, op: DeckOp): Promise<number> {
	const result = await h.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)

	return result.revision
}

function layoutOf(h: EditHarness, slide: SlideNode): SlideNode | undefined {
	return slide.parent === undefined ? undefined : h.session.deck.nodes.get(slide.parent)
}

function masterName(h: EditHarness, slide: SlideNode): string | undefined {
	const layout = layoutOf(h, slide)

	return layout?.parent === undefined ? undefined : h.session.deck.nodes.get(layout.parent)?.name
}

const SLIDE_PART = /^ppt\/slides\/slide\d+\.xml$/u

describe("a gallery theme on a pptx deck", () => {
	it("adds its master and eleven layouts, moves each slide onto the layout of its type and keeps the file's own master", async () => {
		const bytes = await designDeck(["title", "obj", "blank", "twoObj", "secHead"])
		const h = await editHarness(bytes)
		const deck = h.session.deck
		const types = await Promise.all(deck.slides.map(async (_, index) => layoutOf(h, await h.slide(index))?.layoutType))

		await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "gallery", id: "slate", variant: 1 },
			slides: [...deck.slides]
		})

		expect(deck.masters).toHaveLength(2)
		expect(deck.layouts).toHaveLength(22)

		for (const [index] of deck.slides.entries()) {
			const slide = await h.slide(index)

			expect(layoutOf(h, slide)?.layoutType).toBe(types[index])
			expect(masterName(h, slide)).toBe("Filen slate 2")
		}

		h.close()
	})

	it("tells the page the new themes, layouts and colours with the change", async () => {
		const h = await editHarness(await designDeck(["title", "obj"]))
		const before = designInfo(h.session.deck, part => pptxParts(h.session.deck)?.theme(part))

		expect(before.themes).toEqual([
			expect.objectContaining({
				gallery: { id: "filen", variant: 0 },
				colors: {
					background: "FFFFFF",
					text: "000000",
					accents: expect.any(Array) as unknown
				}
			})
		])

		await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "gallery", id: "ember", variant: 3 },
			slides: [...h.session.deck.slides]
		})

		const event = h.events.findLast(each => each.type === "changed")
		const info = event?.type === "changed" ? event.info : undefined

		expect(info?.layouts).toHaveLength(22)
		expect(info?.design?.themes.map(theme => theme.gallery)).toEqual([
			{ id: "filen", variant: 0 },
			{ id: "ember", variant: 3 }
		])
		expect(info?.design?.themes[1]?.colors?.background).toBe("120D0A")
		expect(info?.design?.themes[1]?.fonts).toEqual({
			major: "Cambria",
			minor: "Calibri"
		})
		h.close()
	})

	it("draws the slides on the new theme: its background colour and its master's decoration", async () => {
		const h = await editHarness(await designDeck(["title", "obj"]))
		const slide = h.session.deck.slides[1]

		if (slide === undefined) throw new Error("no slide")

		const [before] = await viewCapability.render(h.context, [slide])

		await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "gallery", id: "slate", variant: 3 },
			slides: [...h.session.deck.slides]
		})

		const [after] = await viewCapability.render(h.context, [slide])
		// slate's dark variant: dk1 #0B1120 is the background (bg1 → dk1), an RGBA paint.
		const dark = { kind: "solid", color: 0x0b1120ff }

		expect(before?.background.paints).toEqual([{ kind: "solid", color: 0xffffffff }])
		expect(after?.background.paints).toEqual([dark])
		expect(after?.layout).toBe((await h.slide(1)).parent)
		h.close()
	})

	it("saves with every slide part byte-identical, only their layout relationships changed, and no dangling reference", async () => {
		const bytes = await designDeck(["title", "obj", "blank"])
		const h = await editHarness(bytes)
		const revision = await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "gallery", id: "harbor", variant: 0 },
			slides: [...h.session.deck.slides]
		})
		const saved = await saveEdits(h, revision)
		const before = await partsOf(bytes)
		const after = await partsOf(saved)

		for (const [name, data] of before) if (SLIDE_PART.test(name)) expect(after.get(name), name).toEqual(data)

		const changed = [...after].filter(([name, data]) => before.has(name) && text(before.get(name)) !== text(data)).map(([name]) => name)

		expect(changed.sort()).toEqual(
			[
				"[Content_Types].xml",
				"ppt/_rels/presentation.xml.rels",
				"ppt/presentation.xml",
				...[1, 2, 3].map(n => `ppt/slides/_rels/slide${String(n)}.xml.rels`)
			].sort()
		)
		expect(after.has("ppt/slideMasters/slideMaster2.xml")).toBe(true)
		expect(after.has("ppt/theme/theme2.xml")).toBe(true)
		expect(text(after.get("ppt/slides/_rels/slide2.xml.rels"))).toContain("slideLayout13.xml")
		expect(await danglingReferences(saved)).toEqual([])

		const reopened = await openPptx(bytesSource(saved))

		if (reopened.kind !== "opened") throw new Error("reopen")

		await reopened.parts.parseAll()
		expect(reopened.deck.masters).toHaveLength(2)

		const slide = reopened.deck.nodes.get(reopened.deck.slides[1] ?? (0 as never))
		const layout = slide?.parent === undefined ? undefined : reopened.deck.nodes.get(slide.parent)

		expect(layout?.layoutType).toBe("obj")
		expect(layout?.parent === undefined ? undefined : reopened.deck.nodes.get(layout.parent)?.name).toBe("Filen harbor 1")
		h.close()
	})

	it("drops a gallery master the session made once no slide uses it, and makes it again on undo after a save", async () => {
		const bytes = await designDeck(["title", "obj"])
		const h = await editHarness(bytes)
		const slides = [...h.session.deck.slides]

		const first = await saveEdits(
			h,
			await run(h, {
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "slate", variant: 0 },
				slides
			})
		)

		await rebaseSession(h, bytes, first)

		const second = await saveEdits(
			h,
			await run(h, {
				family: "design",
				kind: "setTheme",
				theme: { kind: "gallery", id: "ember", variant: 2 },
				slides
			})
		)
		const secondParts = await partsOf(second)

		expect(h.session.deck.masters).toHaveLength(2)
		expect(masterName(h, await h.slide(1))).toBe("Filen ember 3")
		// The slate master the first save wrote is gone with its layouts and theme; the file's own master stays.
		expect([...secondParts.keys()].filter(name => /^ppt\/slideMasters\/[^/]+\.xml$/u.test(name)).sort()).toEqual([
			"ppt/slideMasters/slideMaster1.xml",
			"ppt/slideMasters/slideMaster3.xml"
		])
		expect([...secondParts.keys()].filter(name => /^ppt\/slideLayouts\/[^/]+\.xml$/u.test(name))).toHaveLength(22)
		expect(await danglingReferences(second)).toEqual([])

		await rebaseSession(h, first, second)

		const undone = await h.undo()

		if (!undone.ok) throw new Error("undo")

		expect(h.session.deck.masters).toHaveLength(2)
		expect(masterName(h, await h.slide(1))).toBe("Filen slate 1")

		const third = await partsOf(await saveEdits(h, undone.revision))

		// Made again as the first save wrote it, but for the layout ids (chosen free in the package each save writes).
		const withoutIds = (bytes: Uint8Array | undefined): string => text(bytes).replace(/<p:sldLayoutId id="\d+"/gu, "<p:sldLayoutId")

		expect(withoutIds(third.get("ppt/slideMasters/slideMaster2.xml"))).toBe(
			withoutIds((await partsOf(first)).get("ppt/slideMasters/slideMaster2.xml"))
		)
		expect(third.has("ppt/slideMasters/slideMaster3.xml")).toBe(false)
		h.close()
	})

	it("puts the file's own master back with the deck theme, and an undo restores the gallery one", async () => {
		const bytes = await designDeck(["title", "obj", "blank"])
		const h = await editHarness(bytes)
		const deck = h.session.deck
		const slides = [...deck.slides]
		const own = deck.nodes.get(deck.masters[0] ?? (0 as never))

		await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "gallery", id: "meadow", variant: 3 },
			slides
		})
		await run(h, {
			family: "design",
			kind: "setTheme",
			theme: { kind: "deck", part: own?.part ?? "" },
			slides
		})

		expect(deck.masters).toHaveLength(1)
		expect(masterName(h, await h.slide(1))).toBe("Filen filen 1")
		expect(layoutOf(h, await h.slide(2))?.layoutType).toBe("blank")

		await h.undo()

		expect(masterName(h, await h.slide(1))).toBe("Filen meadow 4")
		await h.undo()
		expect(deck.masters).toHaveLength(1)
		expect(h.events.at(-1)).toMatchObject({ type: "changed", dirty: false })
		h.close()
	})

	it("switches a gallery master's variant for the slides on it", async () => {
		const bytes = await designDeck(["title", "obj"])
		const h = await editHarness(bytes)
		const master = h.session.deck.masters[0]

		if (master === undefined) throw new Error("no master")

		await run(h, { family: "design", kind: "setVariant", master, variant: 3 })
		expect(masterName(h, await h.slide(0))).toBe("Filen filen 4")

		const saved = await saveEdits(h, h.session.deck.revision)

		expect(text((await partsOf(saved)).get("ppt/slideMasters/slideMaster2.xml"))).toContain('bg1="dk1" tx1="lt1"')
		h.close()
	})
})

describe("slide size and backgrounds on a pptx deck", () => {
	it("writes p:sldSz and scales the master's shapes to fit", async () => {
		const bytes = await designDeck(["title", "obj"])
		const h = await editHarness(bytes)
		const revision = await run(h, {
			family: "design",
			kind: "setSize",
			cx: 9_144_000,
			cy: 6_858_000,
			type: "screen4x3",
			scale: "ensureFit"
		})
		const saved = await saveEdits(h, revision)
		const parts = await partsOf(saved)

		expect(text(parts.get("ppt/presentation.xml"))).toContain('<p:sldSz cx="9144000" cy="6858000" type="screen4x3"/>')
		// The master title (838200, 364846) × 0.75, centred vertically: + (6858000 − 6858000 × 0.75) / 2 = 857250.
		expect(text(parts.get("ppt/slideMasters/slideMaster1.xml"))).toContain('<a:off x="628650" y="1130885"/>')
		expect(parts.get("ppt/slides/slide1.xml")).toEqual((await partsOf(bytes)).get("ppt/slides/slide1.xml"))
		h.close()
	})

	it("sets a slide's background, saves it as p:bg and puts the slide back byte for byte on undo", async () => {
		const bytes = await designDeck(["title", "obj"])
		const h = await editHarness(bytes)
		const slide = h.session.deck.slides[1]

		if (slide === undefined) throw new Error("no slide")

		const revision = await run(h, {
			family: "design",
			kind: "setBackground",
			slides: [slide],
			background: {
				kind: "fill",
				fill: { kind: "solid", color: { kind: "srgb", rgb: "112233" } }
			},
			hideGraphics: true
		})
		const saved = await saveEdits(h, revision)
		const markup = text((await partsOf(saved)).get("ppt/slides/slide2.xml"))

		await rebaseSession(h, bytes, saved)

		expect(markup).toContain(
			'<p:bg><p:bgPr><a:solidFill><a:srgbClr val="112233"></a:srgbClr></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
		)
		expect(markup).toContain('showMasterSp="0"')

		const undone = await h.undo()

		if (!undone.ok) throw new Error("undo")

		const back = await saveEdits(h, undone.revision)

		expect((await partsOf(back)).get("ppt/slides/slide2.xml")).toEqual((await partsOf(bytes)).get("ppt/slides/slide2.xml"))
		h.close()
	})
})

void FILEN_THEMES

describe("the file's own theme on an ODP deck", () => {
	it("reassigns the pages' master page, touching nothing in content.xml but the master references", async () => {
		const bytes = await designOdp(3)
		const d = await driveSession(bytes)
		const deck = d.session.deck
		const slate = deck.masters.map(ref => deck.nodes.get(ref)).find(node => node?.name === "Slate")

		if (slate === undefined) throw new Error("no Slate master")

		const result = await d.command({
			family: "design",
			kind: "setTheme",
			theme: { kind: "deck", part: "/styles.xml#Slate" },
			slides: [...deck.slides]
		})

		expect(result.ok).toBe(true)

		const saved = await d.save()
		const before = await entriesOf(bytes)
		const after = await entriesOf(saved.bytes ?? new Uint8Array())

		expect(text(after.get("styles.xml"))).toBe(text(before.get("styles.xml")))
		expect(text(after.get("content.xml"))).toBe(
			text(before.get("content.xml")).replaceAll('draw:master-page-name="Filen"', 'draw:master-page-name="Slate"')
		)
	})

	it("writes a page's solid background into its drawing-page style", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const page = d.session.deck.slides[1]

		if (page === undefined) throw new Error("no page")

		const solid = await d.command({
			family: "design",
			kind: "setBackground",
			slides: [page],
			background: {
				kind: "fill",
				fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } }
			}
		})

		expect(solid.ok).toBe(true)

		const saved = await d.save()
		const content = text((await entriesOf(saved.bytes ?? new Uint8Array())).get("content.xml"))
		const style = /<draw:page draw:name="page2"[^>]* draw:style-name="([^"]+)"/u.exec(content)?.[1]

		expect(style).toBeDefined()
		expect(content).toMatch(
			new RegExp(
				`<style:style [^>]*style:name="${style ?? ""}" style:family="drawing-page"><style:drawing-page-properties[^>]*draw:fill="solid" draw:fill-color="#336699"`,
				"u"
			)
		)
		expect(/<draw:page draw:name="page1"[^>]*>/u.exec(content)?.[0]).not.toContain("draw:style-name")
	})

	it("writes a size change into styles.xml's page layout and moves the master's shapes and the pages' to fit", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const result = await d.command({
			family: "design",
			kind: "setSize",
			cx: 9_144_000,
			cy: 6_858_000,
			scale: "ensureFit"
		})

		expect(result.ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const entries = await entriesOf(saved.bytes ?? new Uint8Array())
		const styles = text(entries.get("styles.xml"))

		expect(styles).toContain('fo:page-width="25.4cm" fo:page-height="19.05cm"')
		// The master title: x 6.875 % of 33.867 cm × 0.75; y (5.32 % of 19.05 cm) × 0.75 + 2.38125 cm.
		expect(styles).toMatch(/presentation:class="title"/u)
		expect(d.session.deck.size).toEqual({ cx: 9_144_000, cy: 6_858_000 })

		const reopened = await driveSession(saved.bytes ?? new Uint8Array())

		expect(reopened.session.deck.size).toEqual({
			cx: 9_144_000,
			cy: 6_858_000
		})
	})
})
