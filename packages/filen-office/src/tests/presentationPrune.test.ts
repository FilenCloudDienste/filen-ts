import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { DECK_HISTORY_LIMITS } from "../core/presentation/edit/history"
import type { DeckOp, FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import { refused, type FillProps, type ShapeNode, type SlideNode, type Xfrm } from "../core/presentation/model"
import type { SmartArtInfo } from "../core/smartart/edit"
import { insertTableOp, insertTextBoxOp } from "../core/presentation/edit/commands/insert"
import { mediaCapability } from "../dom/presentation/engine/media"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { CORPUS_DIR } from "./corpusDir"
import { smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"
import { insertedImage, pictureFillOf, registerInsertedImage } from "../core/presentation/edit/apply/picture"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { clip as shapeClip, clipSlides } from "../dom/presentation/engine/clip"
import { pasteShapesOp, pasteSlidesOps, type ShapeClip, type SlideClip } from "../core/presentation/edit/clip"
import { heldChart, isHeldChart } from "../core/presentation/edit/apply/chart"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { SaveDependencies } from "../dom/presentation/save"
import { pruneCommitted } from "../dom/presentation/prune"

// Parts a session's saves wrote and then stopped using (a replaced picture, a diagram written anew) stay in the file
// only while a step the history holds can bring them back: an undo past the save is exact, and once the history lets
// go of the step (a new edit after an undo, the step limit), the next save leaves them out, with their relationships,
// content types and manifest entries.

const BOX: Xfrm = {
	x: 1_000_000,
	y: 1_000_000,
	cx: 3_000_000,
	cy: 2_000_000,
	rot: 0,
	flipH: false,
	flipV: false
}
const STEP_LIMIT = DECK_HISTORY_LIMITS.maxSteps
const CHART_CELLS = sampleChartCells({ categories: ["A", "B"], series: ["North"] })

type Drive = Awaited<ReturnType<typeof driveSession>>
type Format = "pptx" | "odp"

function deckOf(format: Format): Uint8Array {
	return format === "odp"
		? odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Pictures</text:p></draw:text-box></draw:frame></draw:page>'
			})
		: buildPptx({
				slides: [
					{
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Pictures")))
					}
				]
			})
}

async function saved(d: Drive, format: Format): Promise<ZipArchive> {
	const result = await d.save()

	expect(result.result.kind).toBe("written")

	if (result.bytes === undefined) throw new Error("not saved")
	if (format === "pptx") expect(await danglingReferences(result.bytes)).toEqual([])

	return ZipArchive.open(bytesSource(result.bytes))
}

function pictures(file: ZipArchive): string[] {
	return file.entries.map(entry => entry.name).filter(name => /^(?:ppt\/media|Pictures)\//u.test(name))
}

async function text(file: ZipArchive, name: string): Promise<string> {
	const entry = file.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return new TextDecoder().decode(await file.read(entry))
}

// The picture the slide shows: its image's entry name.
async function shown(file: ZipArchive, format: Format): Promise<string> {
	if (format === "odp") return /xlink:href="(Pictures\/[^"]+)"/u.exec(await text(file, "content.xml"))?.[1] ?? ""

	const slide = await text(file, "ppt/slides/slide1.xml")
	const rels = await text(file, "ppt/slides/_rels/slide1.xml.rels")
	const embed = /<p:pic>[\s\S]*?r:embed="([^"]+)"/u.exec(slide)?.[1] ?? ""

	return `ppt/media/${new RegExp(`Id="${embed}"[^>]*Target="\\.\\./media/([^"]+)"`, "u").exec(rels)?.[1] ?? ""}`
}

async function pictureDeck(format: Format): Promise<{ d: Drive; slide: SlideNode["ref"]; id: number }> {
	const d = await driveSession(deckOf(format), format)
	const slide = d.session.deck.slides[0] as SlideNode["ref"]
	const shape = {
		id: 0,
		name: "Picture",
		hidden: false,
		kind: "pic",
		xfrm: BOX
	} as ShapeNode

	expect(
		(
			await d.command({
				family: "picture",
				kind: "insert",
				slide,
				shape,
				image: image(64, 32)
			})
		).ok
	).toBe(true)

	const node = d.session.deck.nodes.get(slide) as SlideNode
	const id = node.shapes.find(each => each.name === "Picture")?.id ?? 0

	return { d, slide, id }
}

function move(slide: SlideNode["ref"], id: number, x: number): DeckOp {
	return {
		family: "shape",
		kind: "setXfrm",
		target: { slide, id },
		xfrm: { ...BOX, x }
	}
}

async function manifestHas(file: ZipArchive, name: string): Promise<boolean> {
	return (await text(file, "META-INF/manifest.xml")).includes(`"${name}"`)
}

describe("a replaced picture, its image kept while the history can bring it back", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: keeps it for an undo past the save, which shows it again exactly`, async () => {
			const { d, slide, id } = await pictureDeck(format)
			const first = await shown(await saved(d, format), format)

			expect(
				(
					await d.command({
						family: "picture",
						kind: "replace",
						target: { slide, id },
						image: image(70, 32)
					})
				).ok
			).toBe(true)

			const replaced = await saved(d, format)

			expect(pictures(replaced)).toHaveLength(2)
			expect((await d.undo()).ok).toBe(true)
			expect(await shown(await saved(d, format), format)).toBe(first)
		})

		it(`${format}: leaves it out once a new edit after its undo clears the redo`, async () => {
			const { d, slide, id } = await pictureDeck(format)

			await saved(d, format)
			expect(
				(
					await d.command({
						family: "picture",
						kind: "replace",
						target: { slide, id },
						image: image(70, 32)
					})
				).ok
			).toBe(true)

			const second = await shown(await saved(d, format), format)

			expect((await d.undo()).ok).toBe(true)

			// The redo still holds the replacement.
			expect(pictures(await saved(d, format))).toContain(second)
			expect((await d.command(move(slide, id, 9000))).ok).toBe(true)

			const file = await saved(d, format)

			expect(pictures(file)).toEqual([await shown(file, format)])
			expect(pictures(file)).not.toContain(second)
			if (format === "odp") expect(await manifestHas(file, second)).toBe(false)
		})

		it(
			`${format}: leaves the replaced ones out once the step limit drops their steps, bounded over saves`,
			{ timeout: 120_000 },
			async () => {
				const { d, slide, id } = await pictureDeck(format)

				await saved(d, format)

				for (let round = 0; round < 3; round++) {
					expect(
						(
							await d.command({
								family: "picture",
								kind: "replace",
								target: { slide, id },
								image: image(70 + round, 32)
							})
						).ok
					).toBe(true)
					await saved(d, format)
				}

				for (let step = 0; step < STEP_LIMIT; step++) expect((await d.command(move(slide, id, 1000 + step))).ok).toBe(true)

				const file = await saved(d, format)

				expect(pictures(file)).toEqual([await shown(file, format)])
			}
		)
	}
})

describe("an inserted picture undone after its save", () => {
	for (const format of ["pptx", "odp"] as const)
		for (const newEdit of ["move", "text box"] as const)
			for (const between of [false, true])
				it(`${format}: leaves its image out of the save after a new edit (${newEdit}) clears the redo${between ? ", a save between" : ""}`, async () => {
					const d = await driveSession(deckOf(format), format)
					const slide = d.session.deck.slides[0] as SlideNode["ref"]
					const shape = { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

					expect((await d.command({ family: "picture", kind: "insert", slide, shape, image: image(64, 32) })).ok).toBe(true)

					const box = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.kind !== "pic") as ShapeNode

					expect(pictures(await saved(d, format))).toHaveLength(1)
					expect((await d.undo()).ok).toBe(true)
					// The redo still holds the insert.
					if (between) expect(pictures(await saved(d, format))).toHaveLength(1)
					expect(
						(await d.command(newEdit === "move" ? move(slide, box.id, 9000) : insertTextBoxOp(d.session.deck, slide, 60))).ok
					).toBe(true)

					const file = await saved(d, format)

					expect(pictures(file)).toEqual([])
					if (format === "odp") expect(await text(file, "META-INF/manifest.xml")).not.toContain("Pictures/")
				})
})

describe("a diagram written anew for its pictures, its earlier parts kept while the history can bring them back", () => {
	it("leaves the earlier data, drawing and picture out once a new edit after the undo clears the redo", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const slide = d.session.deck.slides[0] as SlideNode["ref"]

		smartArtRenderer(d.session, {
			services: {
				xml: part => pptxParts(d.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		})
		expect(
			(
				await d.command({
					family: "smartart",
					kind: "insert",
					slide,
					shape: {
						id: 0,
						name: "Diagram",
						hidden: false,
						kind: "frame",
						xfrm: BOX
					} as ShapeNode,
					layout: {
						uniqueId: "urn:filen:smartart:layout:picture-caption-list",
						source: "gallery"
					},
					texts: ["Alpha", "Beta"]
				})
			).ok
		).toBe(true)

		const target = {
			slide,
			id: (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Diagram")?.id ?? 0
		}
		const put = async (width: number): Promise<void> => {
			const info = (await smartartCapability.info(d.session, target)) as SmartArtInfo
			const placeholder = info.pictures?.[0]

			if (placeholder === undefined) throw new Error("no placeholder")

			const op: DeckOp = {
				family: "smartart",
				kind: "setPicture",
				target,
				node: placeholder.node,
				placeholder: placeholder.placeholder,
				image: image(width, 16)
			}

			expect((await d.command(op)).ok).toBe(true)
		}
		const diagrams = (file: ZipArchive): string[] =>
			file.entries.map(entry => entry.name).filter(name => /^ppt\/diagrams\/(?:data|drawing)\d*\.xml$/u.test(name))

		await put(32)
		await saved(d, "pptx")
		await put(48)

		const both = await saved(d, "pptx")

		expect(diagrams(both)).toHaveLength(4)
		expect(pictures(both)).toHaveLength(2)
		expect((await d.undo()).ok).toBe(true)
		await saved(d, "pptx")
		expect((await d.command(move(slide, 2, 9000))).ok).toBe(true)

		const file = await saved(d, "pptx")

		expect(diagrams(file)).toHaveLength(2)
		expect(pictures(file)).toHaveLength(1)
		expect(await text(file, "[Content_Types].xml")).not.toContain("drawing2.xml")
	})
})

// A diagram's drawing is named only by its data (dsp:dataModelExt@relId, a relationship of the slide), never by the slide's
// markup: a data part the slide's markup keeps keeps its drawing too.
describe("a diagram's drawing, kept with the data its slide names", () => {
	const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")
	const drawings = (file: ZipArchive): string[] =>
		file.entries
			.map(entry => entry.name)
			.filter(name => /^ppt\/diagrams\/drawing\d*\.xml$/u.test(name))
			.sort()

	async function diagramDeck(): Promise<{
		d: Drive
		slide: SlideNode["ref"]
		other: SlideNode["ref"]
		put: (width: number) => Promise<void>
	}> {
		const d = await driveSession(
			buildPptx({
				slides: [
					{
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P")))
					},
					{
						shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Q")))
					}
				]
			}),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideNode["ref"]
		const other = d.session.deck.slides[1] as SlideNode["ref"]

		smartArtRenderer(d.session, {
			services: {
				xml: part => pptxParts(d.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		})
		expect(
			(
				await d.command({
					family: "smartart",
					kind: "insert",
					slide,
					shape: {
						id: 0,
						name: "Diagram",
						hidden: false,
						kind: "frame",
						xfrm: BOX
					} as ShapeNode,
					layout: {
						uniqueId: "urn:filen:smartart:layout:picture-caption-list",
						source: "gallery"
					},
					texts: ["Alpha", "Beta"]
				})
			).ok
		).toBe(true)

		const target = {
			slide,
			id: (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Diagram")?.id ?? 0
		}
		const put = async (width: number): Promise<void> => {
			const info = (await smartartCapability.info(d.session, target)) as SmartArtInfo
			const placeholder = info.pictures?.[0]

			if (placeholder === undefined) throw new Error("no placeholder")

			const op: DeckOp = {
				family: "smartart",
				kind: "setPicture",
				target,
				node: placeholder.node,
				placeholder: placeholder.placeholder,
				image: image(width, 16)
			}

			expect((await d.command(op)).ok).toBe(true)
		}

		return { d, slide, other, put }
	}

	it.skipIf(!existsSync(PIE))(
		"a PowerPoint deck: a duplicated diagram slide keeps its drawing through the next edit's save",
		async () => {
			const d = await driveSession(new Uint8Array(readFileSync(PIE)), "pptx")
			const slide = d.session.deck.slides[0] as SlideNode["ref"]

			expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

			const first = await saved(d, "pptx")

			expect(
				(
					await d.command({
						family: "slide",
						kind: "hide",
						slides: [d.session.deck.slides[1] as SlideNode["ref"]],
						hidden: true
					})
				).ok
			).toBe(true)

			const second = await saved(d, "pptx")

			expect(drawings(second)).toEqual(drawings(first))
			expect(await text(second, "ppt/slides/_rels/slide2.xml.rels")).toContain("diagramDrawing")
		}
	)

	it("a written diagram: a duplicate of its slide keeps its drawing through the next edit's save", async () => {
		const { d, slide, other, put } = await diagramDeck()

		await put(32)
		await saved(d, "pptx")
		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

		const first = await saved(d, "pptx")

		expect(
			(
				await d.command({
					family: "slide",
					kind: "hide",
					slides: [other],
					hidden: true
				})
			).ok
		).toBe(true)

		const second = await saved(d, "pptx")

		expect(drawings(second)).toEqual(drawings(first))
	})

	it("a diagram's picture set twice: once the history lets go of the steps, the live drawing stays", async () => {
		const { d, other, put } = await diagramDeck()

		await put(32)
		await saved(d, "pptx")
		await put(48)
		await saved(d, "pptx")

		for (let at = 0; at <= STEP_LIMIT; at++)
			expect(
				(
					await d.command({
						family: "slide",
						kind: "hide",
						slides: [other],
						hidden: at % 2 === 0
					})
				).ok
			).toBe(true)

		const file = await saved(d, "pptx")

		expect(drawings(file)).toHaveLength(1)
		expect(pictures(file)).toHaveLength(1)
	})
})

// A redone duplicate's picture or medium: the slide and its image a save wrote, undone and saved without them, then
// redone; once the history lets go of the steps, the copy still shows it and every later save writes it.
function clip(size: number): Uint8Array {
	const bytes = new Uint8Array(size)

	for (let at = 0; at < size; at++) bytes[at] = (at * 31 + 7) & 0xff

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

function deviceFile(bytes: Uint8Array): FileLike {
	return {
		size: bytes.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = bytes.length) => ({
			arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer)
		})
	}
}

describe("a duplicated slide's picture or medium, redone after an undo past a save", () => {
	for (const format of ["pptx", "odp"] as const)
		for (const kind of ["picture", "media"] as const)
			it(`${format}, ${kind}: keeps it once the history lets go of the steps`, async () => {
				const d = await driveSession(
					format === "odp"
						? odpBytes({
								body: [0, 1]
									.map(
										at =>
											`<draw:page draw:name="P${String(at)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(at)}</text:p></draw:text-box></draw:frame></draw:page>`
									)
									.join("")
							})
						: buildPptx({
								slides: [0, 1].map(at => ({
									shapes: sp(
										2,
										"TextBox 1",
										undefined,
										xfrm(100_000, 100_000, 3_000_000, 500_000),
										body(para(`S${String(at)}`))
									)
								}))
							}),
					format
				)

				expect(
					(
						await d.command({
							family: "slide",
							kind: "duplicate",
							slide: d.session.deck.slides[0] as SlideNode["ref"]
						})
					).ok
				).toBe(true)

				const copy = d.session.deck.slides[1] as SlideNode["ref"]
				const shape = {
					id: 0,
					name: "Picture",
					hidden: false,
					kind: "pic",
					xfrm: BOX
				} as ShapeNode

				if (kind === "picture") {
					expect(
						(
							await d.command({
								family: "picture",
								kind: "insert",
								slide: copy,
								shape,
								image: image(37, 8)
							})
						).ok
					).toBe(true)
				} else {
					const registered = await mediaCapability.registerMedia(d.context, {
						kind: "file",
						file: deviceFile(clip(4096))
					})

					if ("reason" in registered) throw new Error(registered.reason)

					const media: InsertedMedia = {
						...registered,
						poster: image(16, 9),
						durationMs: 1000
					}

					expect(
						(
							await d.command({
								family: "media",
								kind: "insert",
								slide: copy,
								shape,
								media
							})
						).ok
					).toBe(true)
				}

				const stored = (file: ZipArchive): string[] =>
					file.entries.map(entry => entry.name).filter(name => /^(?:ppt\/media|Pictures|Media)\//u.test(name))
				const before = stored(await saved(d, format)).length

				expect((await d.undo()).ok).toBe(true)
				expect((await d.undo()).ok).toBe(true)
				await saved(d, format)
				expect((await d.redo()).ok).toBe(true)
				expect((await d.redo()).ok).toBe(true)

				const first = d.session.deck.slides[0] as SlideNode["ref"]

				for (let at = 0; at <= STEP_LIMIT; at++)
					expect(
						(
							await d.command({
								family: "slide",
								kind: "hide",
								slides: [first],
								hidden: at % 2 === 0
							})
						).ok
					).toBe(true)

				expect(stored(await saved(d, format))).toHaveLength(before)
				expect(
					(
						await d.command({
							family: "slide",
							kind: "hide",
							slides: [first],
							hidden: false
						})
					).ok
				).toBe(true)
				expect(stored(await saved(d, format))).toHaveLength(before)
			})
})

describe("an inserted image nothing names any more", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: is let go of once a new edit after the insert's undo clears the redo`, async () => {
			const { d, slide, id } = await pictureDeck(format)
			const node = d.session.deck.nodes.get(slide) as SlideNode
			const inserted = pictureFillOf(node.shapes.find(each => each.id === id) as ShapeNode)?.inserted ?? 0
			const box = node.shapes.find(each => each.kind !== "pic") as ShapeNode

			expect(insertedImage(d.session.deck, inserted)).toBeDefined()
			expect((await d.undo()).ok).toBe(true)
			// The redo still holds the insert.
			expect(insertedImage(d.session.deck, inserted)).toBeDefined()
			expect((await d.command(move(slide, box.id, 9000))).ok).toBe(true)
			// The new edit can still be taken back (retract), the redo with it: let go of once it no longer can.
			expect((await d.command(move(slide, box.id, 9500))).ok).toBe(true)
			expect(insertedImage(d.session.deck, inserted)).toBeUndefined()
		})

		it(`${format}: is kept while a step names it, so an undo of its shape's delete saves it`, async () => {
			const { d, slide, id } = await pictureDeck(format)
			const node = d.session.deck.nodes.get(slide) as SlideNode
			const inserted = pictureFillOf(node.shapes.find(each => each.id === id) as ShapeNode)?.inserted ?? 0

			const box = node.shapes.find(each => each.kind !== "pic") as ShapeNode

			expect((await d.command({ family: "shape", kind: "delete", slide, shapes: [id] })).ok).toBe(true)
			expect((await d.command(move(slide, box.id, 9000))).ok).toBe(true)
			expect((await d.command(move(slide, box.id, 9500))).ok).toBe(true)
			expect(pictures(await saved(d, format))).toEqual([])
			expect(insertedImage(d.session.deck, inserted)).toBeDefined()

			for (let k = 0; k < 3; k++) expect((await d.undo()).ok).toBe(true)

			const file = await saved(d, format)

			expect(pictures(file)).toEqual([await shown(file, format)])
		})
	}

	it("pptx: is let go of after a slide copy too (the copy starts no save)", async () => {
		const { d, slide, id } = await pictureDeck("pptx")
		const node = d.session.deck.nodes.get(slide) as SlideNode
		const inserted = pictureFillOf(node.shapes.find(each => each.id === id) as ShapeNode)?.inserted ?? 0
		const box = node.shapes.find(each => each.kind !== "pic") as ShapeNode

		expect((await clipSlides(d.context, [slide])).ok).toBe(true)
		expect(sessionEdits(d.session).history.saving).toBe(false)
		expect((await d.undo()).ok).toBe(true)
		expect((await d.command(move(slide, box.id, 9000))).ok).toBe(true)
		expect((await d.command(move(slide, box.id, 9500))).ok).toBe(true)
		expect(insertedImage(d.session.deck, inserted)).toBeUndefined()
	})

	// The set-picture step names the image until it is trimmed; the delete's inverse then names it only through the
	// held diagram data its frame names ("raw:N"), which nothing else in the deck or history names.
	for (const removal of ["shape", "slide"] as const)
		it(`pptx: is kept while a ${removal} delete holds a diagram whose held data names it, after its set-picture step is trimmed`, async () => {
			const d = await driveSession(
				buildPptx({
					slides: [
						{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("One"))) },
						{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Two"))) }
					]
				}),
				"pptx"
			)
			const [slide, other] = d.session.deck.slides as [SlideNode["ref"], SlideNode["ref"]]

			smartArtRenderer(d.session, {
				services: {
					xml: part => pptxParts(d.session.deck)?.document(part),
					relationship: () => undefined,
					contentType: () => undefined
				}
			})
			expect(
				(
					await d.command({
						family: "smartart",
						kind: "insert",
						slide,
						shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
						layout: { uniqueId: "urn:filen:smartart:layout:picture-caption-list", source: "gallery" },
						texts: ["Alpha", "Beta"]
					})
				).ok
			).toBe(true)

			const target = {
				slide,
				id: (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Diagram")?.id ?? 0
			}
			const info = (await smartartCapability.info(d.session, target)) as SmartArtInfo
			const placeholder = info.pictures?.[0]

			if (placeholder === undefined) throw new Error("no placeholder")

			expect(
				(
					await d.command({
						family: "smartart",
						kind: "setPicture",
						target,
						node: placeholder.node,
						placeholder: placeholder.placeholder,
						image: image(32, 16)
					})
				).ok
			).toBe(true)

			// The applied op names the registry id the image took.
			const inserted = (sessionEdits(d.session).history.steps().at(-1)?.op as { readonly inserted?: number }).inserted ?? 0

			expect(insertedImage(d.session.deck, inserted)).toBeDefined()

			for (let at = 0; at < 5; at++) expect((await d.command(move(other, 2, 9000 + at))).ok).toBe(true)

			expect(
				(
					await d.command(
						removal === "shape"
							? { family: "shape", kind: "delete", slide, shapes: [target.id] }
							: { family: "slide", kind: "delete", slides: [slide] }
					)
				).ok
			).toBe(true)

			// The insert, the set-picture step and three moves are trimmed; the delete stays.
			const after = STEP_LIMIT - 3

			for (let at = 0; at < after; at++) expect((await d.command(move(other, 2, 20_000 + at))).ok).toBe(true)

			expect(insertedImage(d.session.deck, inserted)).toBeDefined()

			for (let at = 0; at <= after; at++) expect((await d.undo()).ok).toBe(true)

			const file = await saved(d, "pptx")

			expect(pictures(file)).toHaveLength(1)
		})

	it("is kept while held markup a step holds names it, and let go of once none does", async () => {
		const d = await driveSession(deckOf("pptx"), "pptx")
		const deck = d.session.deck
		const slide = deck.slides[0] as SlideNode["ref"]
		const named = registerInsertedImage(deck, image(8, 8), undefined)
		const unnamed = registerInsertedImage(deck, image(9, 8), undefined)
		const history = sessionEdits(d.session).history
		// A diagram's data an undo writes back: it names its picture as the pending id.
		const raw = new TextEncoder().encode(`<dgm:dataModel><a:blip r:embed="inserted:${String(named)}"/></dgm:dataModel>`)

		history.push({
			op: { family: "shape", kind: "restore", target: { slide, id: 2 }, raw },
			inverse: { ops: [], bytes: 0 },
			touches: [],
			before: new Map(),
			after: new Map(),
			bytes: 0,
			burst: undefined
		})
		pruneCommitted(d.session)
		expect(insertedImage(deck, named)).toBeDefined()
		expect(insertedImage(deck, unnamed)).toBeUndefined()
	})
})

// A copy of an unsaved picture lives on the page (its fill names the registry id), outside the deck and the history.
async function copied(d: Drive, slide: SlideNode["ref"], id: number): Promise<ShapeClip> {
	const made = await shapeClip(d.context, { kind: "shapes", slide, shapes: [id] })

	if (!made.ok || made.clip.kind !== "shapes") throw new Error("not copied")

	return made.clip
}

function pasted(copy: ShapeClip, slide: SlideNode["ref"]): DeckOp {
	const op = pasteShapesOp(copy, { slide, boxes: [], sameDeck: true, format: "odp" })

	if (typeof op === "string") throw new Error(op)

	return op
}

function pictureShapes(d: Drive, slide: SlideNode["ref"]): ShapeNode[] {
	return (d.session.deck.nodes.get(slide) as SlideNode).shapes.filter(shape => shape.kind === "pic")
}

describe("a copy of an unsaved picture", () => {
	it("odp: is refused once the registry let go of its image, and the deck stays savable", async () => {
		const { d, slide, id } = await pictureDeck("odp")
		const copy = await copied(d, slide, id)
		const box = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.kind !== "pic") as ShapeNode

		expect((await d.undo()).ok).toBe(true)
		// The first move lets go of the insert (the redo), and with it the image.
		for (let at = 0; at < 2; at++) expect((await d.command(move(slide, box.id, 9000 + at))).ok).toBe(true)

		expect((await d.command(pasted(copy, slide))).ok).toBe(false)
		expect(pictureShapes(d, slide)).toHaveLength(0)
		expect(pictures(await saved(d, "odp"))).toHaveLength(0)
	})

	it("odp: pastes while its insert is held", async () => {
		const { d, slide, id } = await pictureDeck("odp")
		const copy = await copied(d, slide, id)

		expect((await d.command(pasted(copy, slide))).ok).toBe(true)
		expect(pictureShapes(d, slide)).toHaveLength(2)
		expect(pictures(await saved(d, "odp"))).toHaveLength(1)
	})
})

// A refused save's revert undoes back past the refused edit and applies the unrelated steps again: the ops it holds
// meanwhile (an inserted picture, a pasted copy of it) are named by nothing the history holds.
describe("a refused save's revert", () => {
	it("odp: keeps the images of the unrelated steps it applies again", async () => {
		const pending: { detail: string | undefined } = { detail: undefined }
		const refusing = (dependencies: SaveDependencies): SaveDependencies => {
			const saver = dependencies.savers.odp

			if (saver === undefined) throw new Error("no ODP saver")

			const writer: typeof saver.writer = {
				write: saver.writer.write.bind(saver.writer),
				snapshot: async input => {
					const snapshot = await saver.writer.snapshot(input)
					const detail = pending.detail

					if (detail === undefined || ("kind" in snapshot && snapshot.kind === "refused")) return snapshot

					pending.detail = undefined

					return refused("proofFailed", detail)
				}
			}

			return { ...dependencies, savers: { ...dependencies.savers, odp: { ...saver, writer } } }
		}
		const d = await driveSession(
			odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T</text:p></draw:text-box></draw:frame><draw:frame draw:name="U" svg:x="1cm" svg:y="4cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>U</text:p></draw:text-box></draw:frame></draw:page>'
			}),
			"odp",
			[],
			{ dependencies: refusing }
		)
		const slide = d.session.deck.slides[0] as SlideNode["ref"]

		// (A step below the save's: it parses the slide.)
		expect((await d.command(insertTextBoxOp(d.session.deck, slide, 60))).ok).toBe(true)

		const node = d.session.deck.nodes.get(slide) as SlideNode
		const top = node.shapes.filter(shape => shape.synthetic !== true)
		const t = top.findIndex(shape => shape.name === "T")
		const u = top.find(shape => shape.name === "U") as ShapeNode

		expect((await d.command(move(slide, (top[t] as ShapeNode).id, 9000))).ok).toBe(true)
		for (let at = 0; at < 2; at++) expect((await d.command(move(slide, u.id, 20_000 + at))).ok).toBe(true)
		expect(
			(
				await d.command({
					family: "picture",
					kind: "insert",
					slide,
					shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
					image: image(64, 32)
				})
			).ok
		).toBe(true)

		const picture = pictureShapes(d, slide)[0] as ShapeNode

		expect((await d.command(pasted(await copied(d, slide, picture.id), slide))).ok).toBe(true)

		pending.detail = `page 1 (${node.part}) reads back differently: shape ${String(t)} (T) box`

		expect((await d.save()).result.kind).toBe("refused")
		expect(pictureShapes(d, slide)).toHaveLength(2)

		const file = await saved(d, "odp")

		expect(pictures(file)).toHaveLength(1)
		expect(pictureShapes(d, slide)).toHaveLength(2)
	})
})

// A cut's slides live on the page (their nodes name the registry ids), outside the deck and the history: once the
// history lets go of the insert and the cut's delete, the registry lets go of the image too, and a paste of the cut
// must still give a slide a save can write.
function twoSlides(format: Format): Uint8Array {
	return format === "odp"
		? odpBytes({
				body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>One</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="Two" draw:master-page-name="M"><draw:frame draw:name="U" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>Two</text:p></draw:text-box></draw:frame></draw:page>'
			})
		: buildPptx({
				slides: [
					{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("One"))) },
					{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Two"))) }
				]
			})
}

// Cuts the second slide (clip, then its delete) once `insert` put something on it, and lets the history go of both.
async function cutAndTrimmed(
	format: Format,
	insert: (d: Drive, slide: SlideNode["ref"]) => Promise<void>
): Promise<{ d: Drive; held: SlideClip }> {
	const d = await driveSession(twoSlides(format), format)
	const [first, second] = d.session.deck.slides as [SlideNode["ref"], SlideNode["ref"]]

	await insert(d, second)

	// (A step on the first slide parses it.)
	expect((await d.command(insertTextBoxOp(d.session.deck, first, 60))).ok).toBe(true)

	const cut = await shapeClip(d.context, { kind: "slides", slides: [second], cut: true })

	if (!cut.ok || cut.clip.kind !== "slides") throw new Error("not cut")

	expect((await d.command({ family: "slide", kind: "delete", slides: [second] })).ok).toBe(true)

	const box = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(shape => shape.synthetic !== true) as ShapeNode

	for (let at = 0; at < STEP_LIMIT + 2; at++) expect((await d.command(move(first, box.id, 9000 + at))).ok).toBe(true)

	return { d, held: cut.clip }
}

async function pasteCut(d: Drive, held: SlideClip): Promise<boolean> {
	const ops = pasteSlidesOps(held, d.session.deck.slides, 0, true)

	if (typeof ops === "string") throw new Error(ops)

	let ok = true

	for (const op of ops) ok = (await d.command(op)).ok && ok

	return ok
}

describe("a cut slide pasted after the history let go of its delete", () => {
	for (const format of ["pptx", "odp"] as const) {
		it(`${format}: brings back the unsaved picture it names, and the save writes it`, async () => {
			let inserted = 0
			const { d, held } = await cutAndTrimmed(format, async (drive, slide) => {
				expect(
					(
						await drive.command({
							family: "picture",
							kind: "insert",
							slide,
							shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
							image: image(64, 32)
						})
					).ok
				).toBe(true)

				const picture = (drive.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.kind === "pic") as ShapeNode

				inserted = pictureFillOf(picture)?.inserted ?? 0
			})

			expect(inserted).toBeGreaterThan(0)
			// Nothing the deck or the history holds names it any more.
			expect(insertedImage(d.session.deck, inserted)).toBeUndefined()
			expect(await pasteCut(d, held)).toBe(true)
			expect(insertedImage(d.session.deck, inserted)).toBeDefined()

			const file = await saved(d, format)

			expect(pictures(file)).toHaveLength(1)
		})

		it(`${format}: refuses it once the chart version it names was let go of, and the deck stays savable`, async () => {
			let part = ""
			const { d, held } = await cutAndTrimmed(format, async (drive, slide) => {
				expect((await drive.command(insertChartOp(drive.session.deck, slide, 0, "column", CHART_CELLS))).ok).toBe(true)

				const chart = (drive.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.frame?.kind === "chart")

				part = chart?.frame?.kind === "chart" ? chart.frame.part : ""
			})

			expect(isHeldChart(part)).toBe(true)
			expect(heldChart(d.session.deck, part)).toBeUndefined()
			expect(await pasteCut(d, held)).toBe(false)
			expect(d.session.deck.slides).toHaveLength(1)
			await saved(d, format)
		})
	}

	// The diagram's picture is named only by its held data ("raw:N", which the frame names), not by a fill.
	it("pptx: brings back the unsaved picture of a diagram its held data names", async () => {
		let inserted = 0
		const { d, held } = await cutAndTrimmed("pptx", async (drive, slide) => {
			smartArtRenderer(drive.session, {
				services: {
					xml: part => pptxParts(drive.session.deck)?.document(part),
					relationship: () => undefined,
					contentType: () => undefined
				}
			})
			expect(
				(
					await drive.command({
						family: "smartart",
						kind: "insert",
						slide,
						shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
						layout: { uniqueId: "urn:filen:smartart:layout:picture-caption-list", source: "gallery" },
						texts: ["Alpha", "Beta"]
					})
				).ok
			).toBe(true)

			const target = {
				slide,
				id: (drive.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Diagram")?.id ?? 0
			}
			const placeholder = ((await smartartCapability.info(drive.session, target)) as SmartArtInfo).pictures?.[0]

			if (placeholder === undefined) throw new Error("no placeholder")

			expect(
				(
					await drive.command({
						family: "smartart",
						kind: "setPicture",
						target,
						node: placeholder.node,
						placeholder: placeholder.placeholder,
						image: image(32, 16)
					})
				).ok
			).toBe(true)

			inserted = (sessionEdits(drive.session).history.steps().at(-1)?.op as { readonly inserted?: number }).inserted ?? 0
		})

		expect(inserted).toBeGreaterThan(0)
		// The delete let go of last names it only through the held data its frame names.
		expect(insertedImage(d.session.deck, inserted)).toBeUndefined()
		expect(await pasteCut(d, held)).toBe(true)
		expect(insertedImage(d.session.deck, inserted)).toBeDefined()
		expect(pictures(await saved(d, "pptx"))).toHaveLength(1)
	})

	it("odp: a restore naming an image the registry let go of, carried by nothing, is refused", async () => {
		const { d, held } = await cutAndTrimmed("odp", async (drive, slide) => {
			expect(
				(
					await drive.command({
						family: "picture",
						kind: "insert",
						slide,
						shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
						image: image(64, 32)
					})
				).ok
			).toBe(true)
		})
		const bare: SlideClip = { ...held, held: (held.held ?? []).map(({ images: _images, ...entry }) => entry) }

		expect(await pasteCut(d, bare)).toBe(false)
		expect(d.session.deck.slides).toHaveLength(1)
		expect(pictures(await saved(d, "odp"))).toHaveLength(0)
	})
})

// A picture fill the page holds (a format pane's, a stale op's) names its image by registry id: once the history let go
// of every step naming it, setting it on a shape, a background or a table cell is refused (no save could write it), and
// the deck stays savable.
describe("a picture fill set after the registry let go of its image", () => {
	for (const format of ["pptx", "odp"] as const) {
		async function lostFill(): Promise<{ d: Drive; first: SlideNode["ref"]; fill: Extract<FillProps, { kind: "picture" }> }> {
			let inserted = 0
			const { d } = await cutAndTrimmed(format, async (drive, slide) => {
				expect(
					(
						await drive.command({
							family: "picture",
							kind: "insert",
							slide,
							shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
							image: image(64, 32)
						})
					).ok
				).toBe(true)

				const picture = (drive.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.kind === "pic") as ShapeNode

				inserted = pictureFillOf(picture)?.inserted ?? 0
			})

			expect(inserted).toBeGreaterThan(0)
			expect(insertedImage(d.session.deck, inserted)).toBeUndefined()

			return {
				d,
				first: d.session.deck.slides[0] as SlideNode["ref"],
				fill: { kind: "picture", inserted, stretch: { l: 0, t: 0, r: 0, b: 0 } }
			}
		}

		it(`${format}: refuses it as a shape's fill`, async () => {
			const { d, first, fill } = await lostFill()
			const box = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(shape => shape.synthetic !== true) as ShapeNode

			expect((await d.command({ family: "shape", kind: "setProps", target: { slide: first, id: box.id }, props: { fill } })).ok).toBe(
				false
			)
			expect(pictures(await saved(d, format))).toHaveLength(0)
		})

		it(`${format}: refuses it as a slide's background`, async () => {
			const { d, first, fill } = await lostFill()

			expect(
				(await d.command({ family: "design", kind: "setBackground", slides: [first], background: { kind: "fill", fill } })).ok
			).toBe(false)
			expect(pictures(await saved(d, format))).toHaveLength(0)
		})

		it(`${format}: refuses it as a table cell's fill`, async () => {
			const { d, first, fill } = await lostFill()
			const op = insertTableOp(d.session.deck, first, 2, 2, 90)

			if (op === undefined) throw new Error("no table")

			expect((await d.command(op)).ok).toBe(true)

			const table = (d.session.deck.nodes.get(first) as SlideNode).shapes.find(shape => shape.frame?.kind === "table") as ShapeNode

			expect(
				(
					await d.command({
						family: "table",
						kind: "setCellProps",
						target: { slide: first, id: table.id },
						range: { row: 0, col: 0, rows: 1, cols: 1 },
						props: { fill }
					})
				).ok
			).toBe(false)
			expect(pictures(await saved(d, format))).toHaveLength(0)
		})
	}
})
