import { describe, expect, it } from "vitest"
import { effectPreset } from "../core/anim/presets/effects/index"
import { cloneModel } from "../core/presentation/edit/changes"
import { addEffectsOp, slideEffects } from "../core/presentation/edit/commands/timing"
import type { Paragraph, SlideNode, TextBody } from "../core/presentation/model"
import { paragraphMap } from "../core/presentation/edit/apply/timing"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { authoringDeck } from "./animAuthoringFixtures"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"

// A text edit that adds or deletes paragraphs moves the body's by-paragraph effects with their paragraphs: a deleted
// paragraph's effect goes, the rest follow their paragraphs, a paragraph inserted inside the run gets the run's effect,
// and an undo (before a save or after one) writes the timing as it was.

const PAGE =
	'<draw:page draw:name="a" draw:master-page-name="M">' +
	'<draw:frame draw:name="Body" presentation:class="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="9cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list></draw:text-box></draw:frame>' +
	'<draw:custom-shape draw:name="Box" svg:x="18cm" svg:y="15cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle"/></draw:custom-shape>' +
	"</draw:page>"

function preset(presetClass: string, id: number) {
	const found = effectPreset(presetClass, id)

	if (found === undefined) throw new Error("no preset")

	return found
}

type Format = "pptx" | "odp"

async function animatedSession(format: Format) {
	const bytes = format === "pptx" ? authoringDeck() : odpBytes({ body: PAGE })
	const h = await driveSession(bytes, format)
	const slide = async (): Promise<SlideNode> => {
		const deck = h.session.deck
		const parts = format === "pptx" ? pptxParts(deck) : odpParts(deck)
		const node = await parts?.slide(deck.slides[0] ?? (0 as never))

		if (node === undefined) throw new Error("no slide")

		return node as SlideNode
	}
	const first = await slide()
	const body = format === "pptx" ? 3 : (first.shapes.find(shape => shape.name === "Body")?.id ?? -1)
	const box = format === "pptx" ? 4 : (first.shapes.find(shape => shape.name === "Box")?.id ?? -1)
	const op = addEffectsOp(first.ref, [], [{ id: body, paragraphs: 2 }], { preset: preset("entr", 10), byParagraph: true, aspect: 4 / 3 })

	if (op === undefined) throw new Error("no op")

	expect(await h.command(op)).toMatchObject({ ok: true })

	const part = format === "pptx" ? "ppt/slides/slide1.xml" : "content.xml"
	const partOf = async (saved: Uint8Array | undefined): Promise<string> => text((await entriesOf(saved ?? bytes)).get(part))
	const rows = async (): Promise<unknown> => {
		const effects = slideEffects((await slide()).timing)

		return effects.kind === "effects" ? effects.rows.map(row => [row.shape, row.paragraph]) : effects
	}
	const edit = async (change: (paragraphs: Paragraph[]) => void): Promise<void> => {
		const node = await slide()
		const shape = node.shapes.find(candidate => candidate.id === body)

		if (shape?.text === undefined) throw new Error("no body text")

		const edited: TextBody = cloneModel(shape.text)

		change(edited.paragraphs)
		expect(await h.command({ family: "text", kind: "setText", target: { slide: node.ref, id: body }, body: edited })).toMatchObject({
			ok: true
		})
	}
	const addOnBox = async (): Promise<void> => {
		const node = await slide()
		const effects = slideEffects(node.timing)
		const add = addEffectsOp(node.ref, effects.kind === "effects" ? effects.rows : [], [{ id: box }], {
			preset: preset("entr", 10),
			aspect: 4 / 3
		})

		if (add === undefined) throw new Error("no op")

		expect(await h.command(add)).toMatchObject({ ok: true })
	}

	return { h, body, slide, partOf, rows, edit, addOnBox }
}

// Every effect's target names an element the saved file has.
function danglingTargets(format: Format, xml: string): unknown[] {
	if (format === "odp") {
		const ids = new Set([...xml.matchAll(/xml:id="([^"]*)"/gu)].map(match => match[1]))

		return [...xml.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1]).filter(target => !ids.has(target))
	}

	const paragraphs =
		(/<p:sp>(?:(?!<\/p:sp>).)*?<p:cNvPr id="3"(?:(?!<\/p:sp>).)*<\/p:sp>/su.exec(xml)?.[0] ?? "").match(/<a:p>|<a:p /gu)?.length ?? 0

	return [...xml.matchAll(/<p:pRg st="(\d+)" end="(\d+)"/gu)].map(match => Number(match[2])).filter(end => end >= paragraphs)
}

const timingOf = (format: Format, xml: string): string | undefined =>
	(format === "pptx"
		? /<p:timing>.*<\/p:timing>/su
		: /<anim:par [^>]*presentation:node-type="timing-root".*?<\/anim:par>(?=<\/draw:page>|<presentation:notes)/su
	).exec(xml)?.[0]

describe("by-paragraph effects across text edits", () => {
	it("matches paragraphs by their source, then by content, then in order", () => {
		const src = (node: number) => ({ format: "pptx", part: "/ppt/slides/slide1.xml", node, epoch: 0 }) as const
		const p = (text: string, node?: number): Paragraph => ({
			pPr: {},
			runs: [{ kind: "r", text, rPr: {} }],
			...(node === undefined ? {} : { src: src(node) })
		})

		// A source paragraph deleted, one edited, one kept.
		expect([...paragraphMap([p("a", 1), p("b", 2), p("c", 3)], [p("a!", 1), p("c", 3)])]).toEqual([0, -1, 1])
		// Paragraphs without a source: the unchanged ends match, the middle pairs up in order (a split keeps its first half).
		expect([...paragraphMap([p("a"), p("b"), p("c")], [p("a"), p("b1"), p("b2"), p("c")])]).toEqual([0, 1, 3])
		expect([...paragraphMap([p("a"), p("b"), p("c")], [p("a"), p("c")])]).toEqual([0, -1, 1])
	})

	for (const format of ["pptx", "odp"] as const) {
		it(`drops a deleted paragraph's effect and moves the rest with their paragraphs (${format})`, async () => {
			const { h, body, rows, edit, partOf, addOnBox } = await animatedSession(format)

			expect((await h.save()).result.kind).toBe("written")
			await edit(paragraphs => void paragraphs.splice(0, 1))
			expect(await rows()).toEqual([[body, 0]])

			const saved = await h.save()

			expect(saved.result.kind).toBe("written")
			expect(danglingTargets(format, await partOf(saved.bytes))).toEqual([])

			// A later timing edit on the page still saves.
			await addOnBox()

			const again = await h.save()

			expect(again.result.kind).toBe("written")
			expect(danglingTargets(format, await partOf(again.bytes))).toEqual([])
		})

		it(`gives a paragraph inserted inside the run the run's effect (${format})`, async () => {
			const { h, body, rows, edit, partOf } = await animatedSession(format)

			expect((await h.save()).result.kind).toBe("written")
			await edit(paragraphs => {
				const copy = cloneModel(paragraphs[0] as Paragraph)

				delete copy.src
				paragraphs.splice(1, 0, copy)
			})
			expect(await rows()).toEqual([
				[body, 0],
				[body, 1],
				[body, 2]
			])

			// Typing at the end of the body adds a paragraph the run reaches too.
			await edit(paragraphs => void paragraphs.push({ pPr: {}, runs: [{ kind: "r", text: "Four", rPr: {} }] }))
			expect(await rows()).toEqual([
				[body, 0],
				[body, 1],
				[body, 2],
				[body, 3]
			])

			// Two at once, at either end: each its own effect, in paragraph order.
			await edit(paragraphs => {
				const word = (text: string): Paragraph => ({ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] })

				paragraphs.unshift(word("Zero"))
				paragraphs.push(word("Five"), word("Six"))
			})
			expect(await rows()).toEqual(Array.from({ length: 7 }, (_, paragraph) => [body, paragraph]))

			const saved = await h.save()

			expect(saved.result.kind).toBe("written")
			expect(danglingTargets(format, await partOf(saved.bytes))).toEqual([])
		})

		for (const saveBetween of [false, true])
			it(`undoes the edit's timing exactly (${format}, a save between: ${String(saveBetween)})`, async () => {
				const { h, edit, partOf, rows } = await animatedSession(format)
				const before = await h.save()
				const want = timingOf(format, await partOf(before.bytes))
				const effects = await rows()

				expect(want).toBeDefined()
				await edit(paragraphs => void paragraphs.splice(0, 1))

				if (saveBetween) expect((await h.save()).result.kind).toBe("written")

				expect(await h.undo()).toMatchObject({ ok: true })
				expect(await rows()).toEqual(effects)

				const after = await h.save()

				expect(timingOf(format, await partOf(after.bytes ?? before.bytes))).toBe(want)
			})
	}

	it("leaves the timing alone when the paragraphs only change their text", async () => {
		const { slide, edit } = await animatedSession("pptx")
		const timing = (await slide()).timing

		await edit(paragraphs => {
			const run = paragraphs[0]?.runs[0]

			const first = paragraphs[0]

			if (first !== undefined && run?.kind === "r") paragraphs[0] = { ...first, runs: [{ ...run, text: "Uno" }] }
		})
		expect((await slide()).timing).toBe(timing)
	})
})
