import { describe, expect, it } from "vitest"
import { encodePng } from "../core/metafile/dib"
import { bytesSource } from "../core/opc/index"
import { openOdp } from "../core/odp/read/document"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { Background, Deck, SlideNode } from "../core/presentation/model"
import { zipParts, type TemplatePart } from "../core/templates/zip"
import { designOdp } from "./presentationDesignFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf } from "./odpWriteFixtures"
import { text } from "./pptxWriteFixtures"

// Backgrounds that need a drawing resource (gradient, pattern, picture) and gallery themes on an ODP deck: written
// into styles.xml (resources, master pages) and content.xml (page styles, master references), read back by our
// reader as the session had them, undone, and saved again.

type Drive = Awaited<ReturnType<typeof driveSession>>

async function run(d: Drive, op: DeckOp): Promise<void> {
	const result = await d.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)
}

async function saved(d: Drive): Promise<Uint8Array> {
	const outcome = await d.save()

	if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(`not written: ${JSON.stringify(outcome.result)}`)

	return outcome.bytes
}

async function reopen(bytes: Uint8Array): Promise<{ readonly deck: Deck; readonly slides: SlideNode[] }> {
	const opened = await openOdp(bytesSource(bytes))

	if (opened.kind !== "opened") throw new Error(JSON.stringify(opened))

	const slides: SlideNode[] = []

	for (const ref of opened.deck.slides) slides.push(await opened.parts.slide(ref))

	return { deck: opened.deck, slides }
}

function masterOf(deck: Deck, slide: SlideNode): SlideNode | undefined {
	const layout = slide.parent === undefined ? undefined : deck.nodes.get(slide.parent)
	const ref = layout?.kind === "master" ? layout.ref : layout?.parent

	return ref === undefined ? undefined : deck.nodes.get(ref)
}

function png(rgb: readonly [number, number, number], size = 4): Uint8Array {
	const pixels = new Uint8Array(size * size * 4)

	for (let k = 0; k < size * size; k++) pixels.set([...rgb, 255], k * 4)

	return encodePng(pixels, size, size)
}

const GRADIENT: Background = {
	kind: "fill",
	fill: {
		kind: "gradient",
		stops: [
			{ pos: 0, color: { kind: "srgb", rgb: "112233" } },
			{ pos: 100_000, color: { kind: "srgb", rgb: "AABBCC" } }
		],
		linear: { angle: 5_400_000, scaled: false }
	}
}

describe("a gradient, pattern or picture background on an ODP deck", () => {
	it("writes a gradient as a named draw:gradient of styles.xml that the page style names, and reads it back", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const page = d.session.deck.slides[1]

		if (page === undefined) throw new Error("no page")

		await run(d, { family: "design", kind: "setBackground", slides: [page], background: GRADIENT })

		const out = await saved(d)
		const entries = await entriesOf(out)
		const styles = text(entries.get("styles.xml"))
		const content = text(entries.get("content.xml"))
		const name =
			/<draw:gradient draw:name="([^"]+)" draw:style="linear"[^>]*draw:start-color="#112233" draw:end-color="#aabbcc"/iu.exec(
				styles
			)?.[1]

		expect(name).toBeDefined()
		const properties = /<style:drawing-page-properties [^>]*>/u.exec(content)?.[0] ?? ""

		expect(properties).toContain('draw:fill="gradient"')
		expect(properties).toContain(`draw:fill-gradient-name="${name ?? ""}"`)

		const read = await reopen(out)
		const fill = read.slides[1]?.background?.kind === "fill" ? read.slides[1].background.fill : undefined

		expect(fill).toMatchObject({
			kind: "gradient",
			stops: [
				{ pos: 0, color: { kind: "srgb", rgb: "112233" } },
				{ pos: 100_000, color: { kind: "srgb", rgb: "AABBCC" } }
			],
			linear: { angle: 5_400_000 }
		})
		expect(read.slides[0]?.background).toBeUndefined()
	})

	it("stores a picture applied to every page once, in Pictures/ with its manifest entry, and every page shows it", async () => {
		const bytes = await designOdp(4)
		const d = await driveSession(bytes)
		const image = png([200, 30, 30])

		await run(d, {
			family: "design",
			kind: "setBackground",
			slides: "all",
			background: { kind: "fill", fill: { kind: "picture", stretch: { l: 0, t: 0, r: 0, b: 0 } } },
			image: { bytes: image, contentType: "image/png", width: 4, height: 4 }
		})

		const out = await saved(d)
		const entries = await entriesOf(out)
		const pictures = [...entries.keys()].filter(name => name.startsWith("Pictures/"))
		const stored = pictures.filter(name => {
			const entry = entries.get(name)

			return entry !== undefined && entry.length === image.length && entry.every((byte, k) => byte === image[k])
		})

		expect(stored).toHaveLength(1)
		expect(text(entries.get("META-INF/manifest.xml"))).toContain(`manifest:full-path="${stored[0] ?? ""}"`)
		expect(text(entries.get("styles.xml")).match(/<draw:fill-image /gu)).toHaveLength(1)

		const read = await reopen(out)

		for (const slide of read.slides)
			expect(slide.background).toEqual({ kind: "fill", fill: { kind: "picture", part: `/${stored[0] ?? ""}` } })
	})

	it("writes a pattern as LibreOffice's pattern fill, its tile repeated, and a second save keeps one tile", async () => {
		const bytes = await designOdp(3)
		const d = await driveSession(bytes)
		const pattern: Background = {
			kind: "fill",
			fill: { kind: "pattern", preset: "dkUpDiag", fg: { kind: "srgb", rgb: "000080" }, bg: { kind: "srgb", rgb: "FFFFFF" } }
		}

		await run(d, { family: "design", kind: "setBackground", slides: "all", background: pattern })

		const out = await saved(d)
		const entries = await entriesOf(out)
		const tiles = [...entries.keys()].filter(name => name.startsWith("Pictures/"))

		expect(tiles).toHaveLength(1)
		const properties = /<style:drawing-page-properties [^>]*>/u.exec(text(entries.get("content.xml")))?.[0] ?? ""

		expect(properties).toContain('draw:fill="bitmap"')
		expect(properties).toContain('style:repeat="repeat"')

		const read = await reopen(out)

		for (const slide of read.slides)
			expect(slide.background).toMatchObject({ kind: "fill", fill: { kind: "picture", part: `/${tiles[0] ?? ""}`, tile: {} } })

		// A change elsewhere: the backgrounds stay as written, nothing added.
		await run(d, { family: "design", kind: "setBackground", slides: [d.session.deck.slides[0] as never], background: GRADIENT })

		const again = await entriesOf(await saved(d))

		expect([...again.keys()].filter(name => name.startsWith("Pictures/"))).toEqual(tiles)
	})

	it("puts the page's own background back on undo, after a save", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)

		await run(d, { family: "design", kind: "setBackground", slides: "all", background: GRADIENT })
		await saved(d)

		const undone = await d.undo()

		expect(undone.ok).toBe(true)

		const read = await reopen(await saved(d))

		for (const slide of read.slides) expect(slide.background).toBeUndefined()
	})

	it("refuses a gradient ODF holds only nearly (more than two stops), never writing it changed", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const page = d.session.deck.slides[1]

		if (page === undefined) throw new Error("no page")

		await run(d, {
			family: "design",
			kind: "setBackground",
			slides: [page],
			background: {
				kind: "fill",
				fill: {
					kind: "gradient",
					stops: [
						{ pos: 0, color: { kind: "srgb", rgb: "000000" } },
						{ pos: 30_000, color: { kind: "srgb", rgb: "FF0000" } },
						{ pos: 100_000, color: { kind: "srgb", rgb: "FFFFFF" } }
					]
				}
			}
		})

		expect((await d.save()).result).toMatchObject({ kind: "refused", reason: "unsupported" })
	})
})

describe("a gallery theme on an ODP deck", () => {
	it("adds its master page with its styles, moves every page onto it, and the file reads back with it", async () => {
		const bytes = await designOdp(3)
		const d = await driveSession(bytes)
		const deck = d.session.deck

		await run(d, { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 1 }, slides: [...deck.slides] })

		expect(deck.masters).toHaveLength(3)

		const master = deck.nodes.get(deck.masters[2] as never)

		expect(master?.name).toBe("Filen slate 2")
		expect(master?.background).toBeDefined()
		expect(master?.shapes.length).toBeGreaterThan(0)

		for (const ref of deck.slides) expect(masterOf(deck, deck.nodes.get(ref) as SlideNode)?.ref).toBe(master?.ref)

		const out = await saved(d)
		const entries = await entriesOf(out)
		const styles = text(entries.get("styles.xml"))
		const pageName = /<style:master-page style:name="(Filen\d+)" style:display-name="Filen slate 2"/u.exec(styles)?.[1]

		expect(pageName).toBeDefined()
		expect(styles).toContain(`style:name="${pageName ?? ""}-title"`)
		expect(text(entries.get("content.xml")).match(new RegExp(`draw:master-page-name="${pageName ?? ""}"`, "gu"))).toHaveLength(3)

		const read = await reopen(out)

		expect(read.deck.masters.map(ref => read.deck.nodes.get(ref)?.name)).toEqual(deck.masters.map(ref => deck.nodes.get(ref)?.name))

		for (const slide of read.slides) expect(masterOf(read.deck, slide)?.name).toBe("Filen slate 2")

		const readMaster = read.deck.nodes.get(read.deck.masters[2] as never)

		expect(readMaster?.background).toEqual(master?.background)
	})

	it("undoes to the file's master and the next save takes the gallery master page out again", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const deck = d.session.deck
		const original = text((await entriesOf(bytes)).get("styles.xml"))

		await run(d, { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 0 }, slides: [...deck.slides] })
		await saved(d)

		const undone = await d.undo()

		expect(undone.ok).toBe(true)
		expect(deck.masters).toHaveLength(2)

		const out = await saved(d)
		const styles = text((await entriesOf(out)).get("styles.xml"))

		expect(styles).not.toContain('style:display-name="Filen slate 1"')
		expect(styles.match(/<style:master-page /gu)?.length).toBe(original.match(/<style:master-page /gu)?.length)

		const read = await reopen(out)

		// Back on the file's own master page (shown by its display name, the template's theme and variant).
		for (const slide of read.slides) expect(masterOf(read.deck, slide)?.name).toBe("Filen filen 1")

		const redone = await d.redo()

		expect(redone.ok).toBe(true)

		const back = await reopen(await saved(d))

		for (const slide of back.slides) expect(masterOf(back.deck, slide)?.name).toBe("Filen slate 1")
	})

	it("applies a variant as another master page and writes the gallery master again at a new slide size", async () => {
		const bytes = await designOdp(2)
		const d = await driveSession(bytes)
		const deck = d.session.deck

		await run(d, { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 0 }, slides: [...deck.slides] })
		await saved(d)

		const gallery = deck.masters[2]

		if (gallery === undefined) throw new Error("no gallery master")

		await run(d, { family: "design", kind: "setVariant", master: gallery, variant: 2 })
		await run(d, { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "none" })

		const out = await saved(d)
		const styles = text((await entriesOf(out)).get("styles.xml"))

		expect(styles).toContain('style:display-name="Filen slate 3"')
		expect(styles).not.toContain('style:display-name="Filen slate 1"')

		const read = await reopen(out)

		expect(read.deck.size).toEqual({ cx: 9_144_000, cy: 6_858_000 })

		for (const slide of read.slides) expect(masterOf(read.deck, slide)?.name).toBe("Filen slate 3")
	})
})

describe("a presentation object whose style derives from another master's class style", () => {
	// The deck's "Filen" title style without a colour and "Slate"'s red: page 1 moved onto Slate, its title's style
	// still deriving from Filen-title.
	async function variant(master: string): Promise<SlideNode> {
		const entries = await entriesOf(await designOdp(1))
		const parts: TemplatePart[] = []

		for (const [name, data] of entries) {
			if (name === "mimetype") {
				parts.push([name, text(data), "stored"])

				continue
			}

			let markup = text(data).replace(/^<\?xml[^>]*>\s*/u, "")

			if (name === "styles.xml")
				markup = markup
					.replace(/(<style:style style:name="Filen-title"[\s\S]*?<style:text-properties )fo:color="[^"]*" /u, "$1")
					.replace(
						/(<style:style style:name="Slate-title"[\s\S]*?<style:text-properties )fo:color="[^"]*"/u,
						'$1fo:color="#ff0000"'
					)
			if (name === "content.xml") markup = markup.replace('draw:master-page-name="Filen"', `draw:master-page-name="${master}"`)

			parts.push([name, markup])
		}

		const read = await reopen(await zipParts(parts))

		return read.slides[0] as SlideNode
	}

	it("reads it with that style alone, as LibreOffice does: the page's master adds nothing under it", async () => {
		const own = await variant("Filen")
		const moved = await variant("Slate")
		const title = (slide: SlideNode): unknown => {
			const shape = slide.shapes.find(each => each.ph?.type === "title")

			return { text: shape?.text, props: shape?.props }
		}

		expect(JSON.stringify(title(moved))).not.toContain("FF0000")
		expect(title(moved)).toEqual(title(own))
	})
})
