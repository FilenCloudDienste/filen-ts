import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { TimeNode, TimingTree } from "../core/anim/model"
import { withoutShapes } from "../core/anim/prune"
import { digestOf } from "../core/presentation/edit/changes"
import type { SlideNode } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { TIMING_XML, TimingBuilder } from "./animFixtures"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"

// Deleting a shape takes the effects that animate it (and the sequences a click on it triggers) out of the slide's
// timing, as PowerPoint does; undo puts them back, before or after a save wrote the slide without them.

function targets(node: TimeNode, out = new Set<number>()): Set<number> {
	if (node.kind === "behavior") {
		const behavior = node.behavior as { common?: { target: { shape?: number } }; target?: { shape?: number } }
		const shape = (behavior.common?.target ?? behavior.target)?.shape

		if (shape !== undefined) out.add(shape)
	}

	for (const child of node.ctn.children) targets(child, out)

	return out
}

function count(node: TimeNode): number {
	return 1 + node.ctn.children.reduce((sum, child) => sum + count(child), 0)
}

describe("a slide's timing without deleted shapes", () => {
	it("drops the effects on the shapes, the containers left empty, their trigger sequence and builds", () => {
		const b = new TimingBuilder()
		const tree: TimingTree = {
			...b.root([
				b.mainSeq([
					b.click([[0, [b.flyIn(2, "clickEffect")]]]),
					b.click([[0, [b.flyIn(3, "clickEffect"), b.spin(2, "withEffect")]]])
				]),
				b.interactive(2, [b.spin(3, "clickEffect")])
			]),
			builds: [
				{ kind: "bldP", shape: 2, grpId: 0 },
				{ kind: "bldP", shape: 3, grpId: 0 }
			]
		}
		const before = digestOf(tree)
		const roots: TimeNode[] = []
		const pruned = withoutShapes(tree, new Set([2]), roots)

		expect(digestOf(tree)).toBe(before)
		expect(pruned === undefined ? [] : [...targets(pruned.root)]).toEqual([3])
		// The first click group went whole; the second keeps its other effect.
		expect(pruned?.root.ctn.children[0]?.ctn.children).toHaveLength(1)
		expect(pruned?.builds.map(build => build.shape)).toEqual([3])
		expect(roots.length).toBe(3)
		expect(withoutShapes(tree, new Set([9]))).toBe(tree)
		expect(withoutShapes(tree, new Set([2, 3]))).toBeUndefined()
	})
})

function pptxDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					sp(4, "Box", undefined, xfrm(6000000, 1000000, 1000000, 1000000)),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${TIMING_XML}`
			}
		]
	})
}

async function pptxSlideXml(bytes: Uint8Array): Promise<string> {
	return text((await entriesOf(bytes)).get("ppt/slides/slide1.xml"))
}

describe("deleting an animated shape (pptx)", () => {
	it("takes its effects out of p:timing and puts them back on undo after a save", async () => {
		const h = await driveSession(pptxDeck(), "pptx")
		const deck = h.session.deck
		const node = (await pptxParts(deck)?.slide(deck.slides[0]!)) as SlideNode
		const nodes = count(node.timing!.root)

		expect(await h.command({ family: "shape", kind: "delete", slide: node.ref, shapes: [4] })).toMatchObject({ ok: true })

		const deleted = await h.save()

		expect(deleted.result.kind).toBe("written")

		const without = await pptxSlideXml(deleted.bytes!)

		expect(without).not.toContain('spid="4"')
		expect(without).toContain('p14:presetBounceEnd="40000"')
		expect(without).toContain("<p:subTnLst>")

		expect(await h.undo()).toMatchObject({ ok: true })

		const restored = await h.save()

		expect(restored.result.kind).toBe("written")
		expect((await pptxSlideXml(restored.bytes!)).match(/spid="4"/gu)).toHaveLength(3)

		const back = await driveSession(restored.bytes!, "pptx")
		const read = (await pptxParts(back.session.deck)?.slide(back.session.deck.slides[0]!)) as SlideNode

		expect(count(read.timing!.root)).toBe(nodes)
		expect([...targets(read.timing!.root)].sort()).toEqual([2, 3, 4])
	})

	it("saves as unchanged when the delete is undone before any save", async () => {
		const h = await driveSession(pptxDeck(), "pptx")
		const deck = h.session.deck
		const node = (await pptxParts(deck)?.slide(deck.slides[0]!)) as SlideNode

		await h.command({ family: "shape", kind: "delete", slide: node.ref, shapes: [4] })
		await h.undo()

		expect((await h.save()).result.kind).toBe("unchanged")
	})
})

const ODP = join(CORPUS_DIR, "odp", "govuk__bbfa-11-business-lifecycle.odp")

function dangling(content: string): string[] {
	const declared = new Set([...content.matchAll(/(?:xml:id|draw:id|text:id)="([^"]*)"/gu)].map(match => match[1]))

	return [...content.matchAll(/smil:targetElement="([^"]*)"/gu)].map(match => match[1] ?? "").filter(id => !declared.has(id))
}

describe.skipIf(!existsSync(ODP))("deleting an animated shape (ODP)", () => {
	it("leaves no smil:targetElement naming a removed id, and undo after a save puts the effects back", async () => {
		const h = await driveSession(new Uint8Array(readFileSync(ODP)))
		const deck = h.session.deck
		let slide: SlideNode | undefined

		for (const ref of deck.slides) {
			const node = await odpParts(deck)!.slide(ref)

			if (node.timing !== undefined) {
				slide = node

				break
			}
		}

		if (slide?.timing === undefined) throw new Error("no animated page")

		const index = deck.slides.indexOf(slide.ref)
		const all = targets(slide.timing.root)
		const victim = [...all][0]!

		expect(await h.command({ family: "shape", kind: "delete", slide: slide.ref, shapes: [victim] })).toMatchObject({ ok: true })

		const deleted = await h.save()

		expect(deleted.result.kind).toBe("written")
		expect(dangling(text((await entriesOf(deleted.bytes!)).get("content.xml")))).toEqual([])

		expect(await h.undo()).toMatchObject({ ok: true })

		const restored = await h.save()

		expect(restored.result.kind).toBe("written")
		expect(dangling(text((await entriesOf(restored.bytes!)).get("content.xml")))).toEqual([])

		const back = await openOdpDeck(restored.bytes!)
		const page = back.deck.nodes.get(back.deck.slides[index]!)

		expect(page?.timing === undefined ? 0 : targets(page.timing.root).size).toBe(all.size)
	})
})

// The slide's timing markup in a saved file: pptx p:timing, ODP the page's timing-root anim:par.
async function timingMarkup(bytes: Uint8Array, format: "odp" | "pptx", part: string, index: number): Promise<string> {
	const entries = await entriesOf(bytes)

	if (format === "pptx") return /<p:timing>[\s\S]*?<\/p:timing>/u.exec(text(entries.get(part.slice(1))))?.[0] ?? ""

	const pages = text(entries.get("content.xml"))
		.split(/(?=<draw:page[\s>])/u)
		.slice(1)
	const page = (pages[index] ?? "").split("</draw:page>")[0] ?? ""
	const start = page.search(/<anim:par[^>]*presentation:node-type="timing-root"/u)

	return start < 0 ? "" : (page.slice(start).split("<presentation:notes")[0] ?? "")
}

function animatedDecks(format: "odp" | "pptx", count: number): string[] {
	const directory = join(CORPUS_DIR, format)

	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter(name => name.endsWith(`.${format}`))
		.sort()
		.filter(name => {
			const bytes = readFileSync(join(directory, name))

			return format === "pptx" ? bytes.includes("ppt/slides/") : true
		})
		.slice(0, 400)
		.map(name => join(directory, name))
		.slice(0, count * 20)
}

describe.skipIf(!existsSync(join(CORPUS_DIR, "odp")))("deleting an animated shape, saving and undoing, three times over (corpus)", () => {
	for (const format of ["pptx", "odp"] as const)
		it(`puts every ${format} timing back byte for byte`, { timeout: 300_000 }, async () => {
			let decks = 0

			for (const path of animatedDecks(format, 4)) {
				if (decks >= 4) break

				const original = new Uint8Array(readFileSync(path))
				let h: Awaited<ReturnType<typeof driveSession>>

				try {
					h = await driveSession(original, format)
				} catch {
					continue
				}

				const deck = h.session.deck
				const parts = format === "pptx" ? pptxParts(deck) : odpParts(deck)
				let found: { node: SlideNode; index: number; shape: number } | undefined

				for (const [index, ref] of deck.slides.entries()) {
					const node = (await parts?.slide(ref)) as SlideNode | undefined
					const animated = node?.timing === undefined ? new Set<number>() : targets(node.timing.root)
					const shape = node?.shapes.find(candidate => animated.has(candidate.id) && candidate.lock === undefined)

					if (node !== undefined && shape !== undefined) {
						found = { node, index, shape: shape.id }

						break
					}
				}

				if (found === undefined) continue

				const before = await timingMarkup(original, format, found.node.part, found.index)

				if (before === "") continue

				const deleted = await h.command({ family: "shape", kind: "delete", slide: found.node.ref, shapes: [found.shape] })

				if (!deleted.ok) continue

				decks++

				for (let cycle = 0; cycle < 3; cycle++) {
					if (cycle > 0) expect(await h.redo(), path).toMatchObject({ ok: true })

					const without = await h.save()

					expect(without.result.kind, path).toBe("written")
					expect(await h.undo(), path).toMatchObject({ ok: true })

					const back = await h.save()

					expect(back.result.kind, path).toBe("written")
					expect(await timingMarkup(back.bytes!, format, found.node.part, found.index), `${path} cycle ${String(cycle)}`).toBe(
						before
					)
				}
			}

			expect(decks).toBeGreaterThanOrEqual(3)
		})
})
