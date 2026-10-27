import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { memorySink } from "../core/opc/index"
import { proveOdpSlide } from "../core/odp/write/proof"
import { odpSnapshot, writeOdpSnapshot } from "../core/odp/write/save"
import { odpWriteSource } from "../core/odp/write/source"
import type { PptxSaveOutcome } from "../core/pptx/write/types"
import { refused, type Deck, type SlideNode, type SlideRef } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { saveSession, type SaveDependencies } from "../dom/presentation/save"
import { CORPUS_DIR } from "./corpusDir"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { ODP_DECK, changes, entriesOf, odpDeck, openOdpDeck, shapeNamed, slideAt, text, touched } from "./odpWriteFixtures"

// The ODP writer through the engine's session: undo of saved shape deletes, pages that jump to other pages through
// gate 1 and gate 2, the scope of a refused save's revert, and random edit/undo/save chains.

type Session = Awaited<ReturnType<typeof driveSession>>

async function slide(session: Session, index: number): Promise<SlideNode> {
	const ref = session.session.deck.slides[index] as SlideRef

	return odpParts(session.session.deck)?.slide(ref) as Promise<SlideNode>
}

async function pageNames(bytes: Uint8Array): Promise<string[]> {
	return [...text((await entriesOf(bytes)).get("content.xml")).matchAll(/<draw:page [^>]*draw:name="([^"]*)"/gu)].map(m => m[1] ?? "")
}

// Per page of a deck, its shape names in order (groups with their members).
function shapeNames(deck: Deck, nodes: readonly (SlideNode | undefined)[]): string[][] {
	const names = (shapes: SlideNode["shapes"]): string[] =>
		shapes.filter(shape => shape.synthetic !== true).flatMap(shape => [shape.name, ...names(shape.children ?? [])])

	return deck.slides.map((_, k) => names(nodes[k]?.shapes ?? []))
}

describe("ODP saves of shape deletes and their undo", () => {
	for (const name of ["Box", "Title", "Group", "Line"])
		it(`saves the undo of a saved delete of ${name}, and every later save of the session`, async () => {
			const h = await driveSession(odpDeck())
			const intro = await slide(h, 0)
			const target = shapeNamed(intro, name)

			expect(await h.command({ family: "shape", kind: "delete", slide: intro.ref, shapes: [target.id] })).toMatchObject({ ok: true })
			expect((await h.save()).result.kind).toBe("written")
			expect(await h.undo()).toMatchObject({ ok: true })
			expect((await h.save()).result.kind).toBe("written")

			const end = await slide(h, 2)
			const title = shapeNamed(end, "Title3")

			await h.command({ family: "shape", kind: "setXfrm", target: { slide: end.ref, id: title.id }, xfrm: { ...title.xfrm!, x: 0 } })

			const restored = shapeNamed(h.session.deck.nodes.get(intro.ref)!, name)

			if (restored.xfrm !== undefined)
				await h.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide: intro.ref, id: restored.id },
					xfrm: { ...restored.xfrm, x: restored.xfrm.x + 12700 }
				})

			const later = await h.save()

			expect(later.result.kind).toBe("written")

			const back = await openOdpDeck(later.bytes!)
			const moved = shapeNamed(slideAt(back, 0), name)

			if (restored.xfrm !== undefined) expect(Math.abs((moved.xfrm?.x ?? 0) - restored.xfrm.x)).toBeLessThanOrEqual(2)
		})

	it("saves a restored shape that a later edit on its page moved, without a save between", async () => {
		const h = await driveSession(odpDeck())
		const intro = await slide(h, 0)

		await h.command({ family: "shape", kind: "delete", slide: intro.ref, shapes: [shapeNamed(intro, "Box").id] })
		await h.undo()

		const title = shapeNamed(h.session.deck.nodes.get(intro.ref)!, "Title")

		await h.command({ family: "shape", kind: "setXfrm", target: { slide: intro.ref, id: title.id }, xfrm: { ...title.xfrm!, x: 0 } })

		expect((await h.save()).result.kind).toBe("written")
	})
})

describe("ODP pages that jump to other pages", () => {
	it("proves a shape linked to another page and a text link without locking them", async () => {
		const opened = await openOdpDeck(odpDeck())
		const middle = slideAt(opened, 1)
		const tally = proveOdpSlide({ deck: opened.deck, slide: middle, source: odpWriteSource(opened.parts) })

		expect(tally.failures).toEqual({})
		expect([shapeNamed(middle, "Jump").lock, shapeNamed(middle, "Title2").lock]).toEqual([undefined, undefined])
	})

	it("saves a duplicate of a page holding a jump, and a page whose jump target moved", async () => {
		const h = await driveSession(odpDeck())
		const middle = await slide(h, 1)

		await h.command({ family: "slide", kind: "duplicate", slide: middle.ref })

		const duplicated = await h.save()

		expect(duplicated.result.kind).toBe("written")
		expect(await pageNames(duplicated.bytes!)).toHaveLength(4)

		const intro = await slide(h, 0)

		await h.command({ family: "slide", kind: "delete", slides: [intro.ref] })

		const title = shapeNamed(h.session.deck.nodes.get(middle.ref)!, "Title2")

		await h.command({ family: "shape", kind: "setXfrm", target: { slide: middle.ref, id: title.id }, xfrm: { ...title.xfrm!, x: 0 } })

		const moved = await h.save()

		expect(moved.result.kind).toBe("written")
		expect(text((await entriesOf(moved.bytes!)).get("content.xml"))).toContain('xlink:href="#End"')
	})
})

describe("an ODP save refused on one page", () => {
	it("names the page's model part in the refusal", async () => {
		const opened = await openOdpDeck(odpDeck())
		const middle = touched(slideAt(opened, 1))
		const title = shapeNamed(middle, "Title2")

		title.xfrm = { ...title.xfrm!, x: title.xfrm!.x + 12700 }

		const snapshot = await odpSnapshot({ deck: opened.deck, source: { parts: opened.parts }, changes: changes(), revision: 1 })

		if ("reason" in snapshot) throw new Error(snapshot.detail)

		// The model changes after the snapshot: the written page no longer reads as the session holds it.
		shapeNamed(middle, "Jump").name = "Elsewhere"

		const outcome = (await writeOdpSnapshot(snapshot, memorySink())) as PptxSaveOutcome

		expect(outcome).toMatchObject({ kind: "refused", reason: "proofFailed" })
		expect(outcome.kind === "refused" ? outcome.detail : "").toContain(`(${middle.part})`)
	})

	it("reverts only the steps of the page a refused save names, keeping an edit on another page", async () => {
		const events: { type: string; notice?: { kind: string; ops: number } }[] = []
		const h = await driveSession(odpDeck(), "odp", events)
		const intro = await slide(h, 0)
		const middle = await slide(h, 1)
		const box = shapeNamed(intro, "Box")
		const jump = shapeNamed(middle, "Jump")

		await h.command({ family: "shape", kind: "setXfrm", target: { slide: intro.ref, id: box.id }, xfrm: { ...box.xfrm!, x: 0 } })
		await h.command({ family: "shape", kind: "setXfrm", target: { slide: middle.ref, id: jump.id }, xfrm: { ...jump.xfrm!, x: 0 } })

		// A writer whose check refuses the middle page, as gate 2 names a page.
		const odp = SAVE_DEPENDENCIES.savers.odp!
		const refusing: SaveDependencies = {
			...SAVE_DEPENDENCIES,
			savers: {
				...SAVE_DEPENDENCIES.savers,
				odp: {
					...odp,
					writer: {
						...odp.writer,
						write: () =>
							Promise.resolve(refused("proofFailed", `page 2 (${middle.part}) reads back differently: shape 1 (Jump) box`))
					}
				}
			}
		}
		const { port1 } = new MessageChannel()
		const result = await saveSession(h.context, { reason: "user", port: port1 as never }, refusing)

		port1.close()

		expect(result.kind).toBe("refused")
		expect(events.filter(event => event.notice?.kind === "saveReverted").map(event => event.notice?.ops)).toEqual([1])
		expect(shapeNamed(h.session.deck.nodes.get(intro.ref)!, "Box").xfrm?.x).toBe(0)
		expect(shapeNamed(h.session.deck.nodes.get(middle.ref)!, "Jump").xfrm?.x).toBe(jump.xfrm?.x)
	})
})

// The fixture with page backgrounds and a transition on the pages that use dp1 (what a restored page's fields compare).
function dressedDeck(): Uint8Array {
	return odpBytes({
		...ODP_DECK,
		automatic: (ODP_DECK.automatic ?? "").replace(
			'<style:drawing-page-properties presentation:background-visible="true"/>',
			'<style:drawing-page-properties presentation:background-visible="true" draw:fill="solid" draw:fill-color="#336699" smil:type="fade" smil:subtype="crossfade" presentation:transition-speed="medium"/>'
		),
		body: ODP_DECK.body.replace('<draw:page draw:name="Middle"', '<draw:page draw:name="Middle" draw:style-name="dp1"')
	})
}

describe("ODP edit chains", () => {
	it("saves the undo of a saved slide delete, page background and transition included, and every save after", async () => {
		const h = await driveSession(dressedDeck())
		const deck = h.session.deck

		for (const index of [0, 1]) {
			const page = await slide(h, index)

			expect(page.background).toBeDefined()
			expect(await h.command({ family: "slide", kind: "delete", slides: [page.ref] })).toMatchObject({ ok: true })
			expect((await h.save()).result.kind).toBe("written")
			expect(await h.undo()).toMatchObject({ ok: true })

			const back = await h.save()

			expect(back.result.kind).toBe("written")
			expect(deck.slides).toHaveLength(3)
			expect(text((await entriesOf(back.bytes!)).get("content.xml"))).toContain(`draw:name="${page.name ?? ""}"`)
		}

		const box = shapeNamed(await slide(h, 0), "Box")

		await h.command({ family: "shape", kind: "setXfrm", target: { slide: deck.slides[0]!, id: box.id }, xfrm: { ...box.xfrm!, x: 0 } })
		expect((await h.save()).result.kind).toBe("written")
	})

	it("saves the undo of a saved delete of a page whose own style a save retired, every page parsed as the editor shows them", async () => {
		// Middle's drawing-page style is its own: the delete's save takes it out of content.xml.
		const bytes = odpBytes({
			...ODP_DECK,
			automatic: `${ODP_DECK.automatic ?? ""}<style:style style:name="dp9" style:family="drawing-page"><style:drawing-page-properties presentation:background-visible="true" draw:fill="solid" draw:fill-color="#993366"/></style:style>`,
			body: ODP_DECK.body.replace('<draw:page draw:name="Middle"', '<draw:page draw:name="Middle" draw:style-name="dp9"')
		})
		const h = await driveSession(bytes)
		const deck = h.session.deck

		for (let index = 0; index < deck.slides.length; index++) await slide(h, index)

		const middle = await slide(h, 1)

		expect(middle.background).toBeDefined()
		expect(await h.command({ family: "slide", kind: "delete", slides: [middle.ref] })).toMatchObject({ ok: true })

		const deleted = await h.save()

		expect(deleted.result.kind).toBe("written")
		expect(text((await entriesOf(deleted.bytes!)).get("content.xml"))).not.toContain('style:name="dp9"')
		expect(await h.undo()).toMatchObject({ ok: true })

		const back = await h.save()

		expect(back.result.kind).toBe("written")
		expect(text((await entriesOf(back.bytes!)).get("content.xml"))).toContain('style:name="dp9"')
		expect(slideAt(await openOdpDeck(back.bytes!), 1).background).toEqual(middle.background)
	})

	it("keeps a page's notes when slides deleted before a save come back by undo after it", async () => {
		const h = await driveSession(odpDeck())
		const deck = h.session.deck
		const middle = await slide(h, 1)
		const end = await slide(h, 2)

		await h.command({ family: "slide", kind: "delete", slides: [middle.ref, end.ref] })
		expect((await h.save()).result.kind).toBe("written")

		// Parsed only now, from the saved file: its notes get a ref of the new reading.
		const intro = await slide(h, 0)

		expect(await h.undo()).toMatchObject({ ok: true })
		expect(deck.slides).toHaveLength(3)
		expect(intro.notes === undefined ? undefined : deck.nodes.get(intro.notes)?.kind).toBe("notes")

		const box = shapeNamed(intro, "Box")

		await h.command({ family: "shape", kind: "setXfrm", target: { slide: intro.ref, id: box.id }, xfrm: { ...box.xfrm!, x: 0 } })
		expect((await h.save()).result.kind).toBe("written")
	})

	it("saves random delete/duplicate/move/undo/redo chains whole, page for page", { timeout: 300_000 }, async () => {
		let written = 0
		const failures: string[] = []

		for (let seed = 1; seed <= 30; seed++) {
			let state = seed * 2_654_435_761
			const next = (): number => {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

				return state / 4_294_967_296
			}
			// Half the seeds on pages with backgrounds and transitions (restored pages compare their page fields too).
			const h = await driveSession(seed % 2 === 0 ? dressedDeck() : odpBytes(ODP_DECK))
			const deck = h.session.deck
			const pick = async (): Promise<SlideNode> => slide(h, Math.floor(next() * deck.slides.length))
			let saves = 0

			for (let step = 0; step < 40 && failures.length === 0; step++) {
				const roll = next()

				if (roll < 0.12 && deck.slides.length > 1)
					await h.command({ family: "slide", kind: "delete", slides: [(await pick()).ref] })
				else if (roll < 0.22) await h.command({ family: "slide", kind: "duplicate", slide: (await pick()).ref })
				else if (roll < 0.32)
					await h.command({
						family: "slide",
						kind: "move",
						slides: [(await pick()).ref],
						to: Math.floor(next() * deck.slides.length)
					})
				else if (roll < 0.47) {
					const node = await pick()
					const shape = node.shapes[Math.floor(next() * node.shapes.length)]

					if (shape !== undefined && shape.synthetic !== true)
						await h.command({ family: "shape", kind: "delete", slide: node.ref, shapes: [shape.id] })
				} else if (roll < 0.6) {
					const node = await pick()
					const shape = node.shapes.find(candidate => candidate.xfrm !== undefined && candidate.lock === undefined)

					if (shape?.xfrm !== undefined)
						await h.command({
							family: "shape",
							kind: "setXfrm",
							target: { slide: node.ref, id: shape.id },
							xfrm: { ...shape.xfrm, x: shape.xfrm.x + 12700 }
						})
				} else if (roll < 0.72) await h.undo()
				else if (roll < 0.8) await h.redo()
				else {
					const saved = await h.save()

					if (saved.result.kind === "refused")
						failures.push(`seed ${String(seed)} step ${String(step)}: refused ${saved.result.reason}`)
					if (saved.result.kind !== "written") continue

					saves++
					written++

					// Every page and every shape the session holds is in the file, in order: nothing dropped.
					const back = await openOdpDeck(saved.bytes!)
					const now = await Promise.all(deck.slides.map(ref => odpParts(deck)!.slide(ref)))
					const read = back.deck.slides.map(ref => back.deck.nodes.get(ref))

					expect(shapeNames(back.deck, read)).toEqual(shapeNames(deck, now))
					expect(back.deck.slides).toHaveLength(deck.slides.length)
				}
			}

			if (saves < 3 && failures.length === 0) {
				const saved = await h.save()

				if (saved.result.kind === "refused") failures.push(`seed ${String(seed)} final: refused ${saved.result.reason}`)
			}
		}

		expect(failures).toEqual([])
		expect(written).toBeGreaterThanOrEqual(60)
	})
})

const WORKSHOP = join(CORPUS_DIR, "odp", "govuk__Workshop_in_a_box_slides_ODP.odp")
const LIFECYCLE = join(CORPUS_DIR, "odp", "govuk__bbfa-11-business-lifecycle.odp")

describe.skipIf(!existsSync(WORKSHOP) || !existsSync(LIFECYCLE))("ODP layouts and groups on corpus decks", () => {
	it("saves a new slide given another layout, its placeholders placed by the layout's master", async () => {
		const h = await driveSession(new Uint8Array(readFileSync(WORKSHOP)))
		const deck = h.session.deck
		const third = await slide(h, 2)
		const other = deck.layouts.find(ref => ref !== third.parent)

		expect(other).toBeDefined()
		expect(await h.command({ family: "slide", kind: "add", at: 3, layout: third.parent! })).toMatchObject({ ok: true })
		expect(await h.command({ family: "slide", kind: "setLayout", slide: deck.slides[3]!, layout: other! })).toMatchObject({ ok: true })
		expect((await h.save()).result.kind).toBe("written")
	})

	it("saves a slide given its own layout again, and one whose master is not parsed", async () => {
		const h = await driveSession(new Uint8Array(readFileSync(LIFECYCLE)))
		const deck = h.session.deck
		const first = await slide(h, 0)
		const layout = deck.nodes.get(first.parent!)

		// The layout's master unparsed: the writer names it from styles.xml's order.
		if (layout?.parent !== undefined) deck.nodes.delete(layout.parent)

		expect(await h.command({ family: "slide", kind: "add", at: 1, layout: first.parent! })).toMatchObject({ ok: true })
		expect((await h.save()).result.kind).toBe("written")
	})

	it("groups ODP presentation objects and custom shapes, each moved start tag with its xml:id", async () => {
		for (const [path, index] of [
			[WORKSHOP, 3],
			[LIFECYCLE, 2]
		] as const) {
			const h = await driveSession(new Uint8Array(readFileSync(path)))
			const page = await slide(h, index)
			const members = page.shapes.slice(0, 2)

			expect(
				await h.command({ family: "shape", kind: "group", slide: page.ref, shapes: members.map(shape => shape.id) }),
				path
			).toMatchObject({
				ok: true
			})

			const saved = await h.save()

			expect(saved.result.kind, path).toBe("written")

			const content = text((await entriesOf(saved.bytes!)).get("content.xml"))
			const group = /<draw:g\b[\s\S]*?<\/draw:g>/u.exec(content)?.[0] ?? ""

			for (const tag of group.match(/<draw:(?:frame|custom-shape)\b[^>]*>/gu) ?? []) {
				const drawId = /\sdraw:id="([^"]*)"/u.exec(tag)?.[1]

				if (drawId !== undefined) expect(tag, path).toContain(`xml:id="${drawId}"`)
			}
		}
	})
})
