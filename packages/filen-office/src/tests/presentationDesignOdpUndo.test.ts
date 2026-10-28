import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type Background, type SlideRef } from "../core/presentation/model"
import { odpSourceReading } from "../core/odp/write/session"
import { PAGE_NODE, odpWriteSource } from "../core/odp/write/source"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"
import { designOdp } from "./presentationDesignFixtures"

// Design ops on an ODP deck, saved, then undone and saved again: the pages and styles.xml are back in their source
// state, so the save writes the source's own bytes for them (each op's inverse holds the markup of the pages it
// changed and, when styles.xml was the file's own, its bytes), not an equivalent rewrite.

type Drive = Awaited<ReturnType<typeof driveSession>>

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

async function run(d: Drive, op: DeckOp): Promise<void> {
	const result = await d.command(op)

	if (!result.ok) throw new Error(`refused: ${JSON.stringify(result)}`)
}

async function written(d: Drive): Promise<Uint8Array> {
	const outcome = await d.save()

	if (outcome.result.kind !== "written" || outcome.bytes === undefined) throw new Error(`not written: ${JSON.stringify(outcome.result)}`)

	return outcome.bytes
}

async function sameParts(source: Uint8Array, out: Uint8Array): Promise<void> {
	const a = await entriesOf(source)
	const b = await entriesOf(out)

	for (const name of ["content.xml", "styles.xml"])
		expect(Buffer.from(b.get(name) ?? []).equals(Buffer.from(a.get(name) ?? [])), name).toBe(true)
}

function ops(slides: readonly SlideRef[]): Record<string, DeckOp> {
	return {
		theme: { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 1 }, slides: [...slides] },
		background: { family: "design", kind: "setBackground", slides: "all", background: GRADIENT },
		"one page's background": {
			family: "design",
			kind: "setBackground",
			slides: [slides[1] as SlideRef],
			background: { kind: "fill", fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } } }
		},
		size: { family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" }
	}
}

describe("an ODP page's markup held by an inverse", () => {
	it("is the page's own bytes in content.xml, read without parsing the page", async () => {
		const opened = await openOdpDeck(await designOdp(2))
		const reading = odpSourceReading(opened.deck, odpWriteSource(opened.parts), { next: () => slideRef(0x4000_0000) })
		const content = text((await entriesOf(opened.bytes)).get("content.xml"))

		for (const ref of opened.deck.slides) {
			const node = opened.deck.nodes.get(ref)

			if (node === undefined) throw new Error("no page")

			expect(node.src?.node).toBe(PAGE_NODE)

			const parts = reading.rawParts(node)
			const bytes = Array.isArray(parts) ? parts[0]?.bytes : undefined
			const markup = text(bytes)

			expect(markup.startsWith("<draw:page ")).toBe(true)
			expect(content).toContain(markup)
		}
	})
})

describe("an ODP design op saved, undone and saved again", () => {
	for (const what of ["theme", "background", "one page's background", "size"])
		it(`writes the source's content.xml and styles.xml after ${what}`, async () => {
			const source = await designOdp(3)
			const d = await driveSession(source)

			await run(d, ops(d.session.deck.slides)[what] as DeckOp)
			await written(d)
			await d.undo()
			await sameParts(source, await written(d))
		})

	it("writes the source's parts after a variant of a gallery theme saved in between", async () => {
		const d = await driveSession(await designOdp(2))
		const deck = d.session.deck

		await run(d, { family: "design", kind: "setTheme", theme: { kind: "gallery", id: "slate", variant: 0 }, slides: [...deck.slides] })

		const themed = await written(d)
		const gallery = deck.masters[2] as SlideRef

		await run(d, { family: "design", kind: "setVariant", master: gallery, variant: 2 })
		await written(d)
		await d.undo()
		await sameParts(themed, await written(d))
	})

	it("writes the source's parts after every op undone, with a redo and undo across a save", async () => {
		const source = await designOdp(3)
		const d = await driveSession(source)
		const all = ops(d.session.deck.slides)

		for (const what of ["theme", "background", "size"]) await run(d, all[what] as DeckOp)

		await written(d)
		for (let k = 0; k < 3; k++) await d.undo()
		await d.redo()
		await written(d)
		await d.undo()
		await sameParts(source, await written(d))
	})
})

// Corpus decks LibreOffice wrote (cm lengths, text:id beside xml:id, font faces), every op applied, saved, undone.
const CORPUS = ["tika__LibreOfficeImpress_odp_1.3.odp", "lo__tdf100387.odp", "lo__repeatBitmapMode.odp", "lo__tdf53970.odp"]

describe("ODP corpus decks with theme, background and size undone after a save", () => {
	for (const name of CORPUS) {
		const file = join(CORPUS_DIR, "odp", name)

		it.skipIf(!existsSync(file))(
			`writes ${name}'s own content.xml and styles.xml`,
			async () => {
				const source = new Uint8Array(readFileSync(file))
				const d = await driveSession(source)
				const all = ops(d.session.deck.slides)

				for (const what of ["theme", "background", "size"]) await run(d, all[what] as DeckOp)

				await written(d)
				for (let k = 0; k < 3; k++) await d.undo()
				await sameParts(source, await written(d))
			},
			60_000
		)
	}
})
