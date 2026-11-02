import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { DeckOp, FileLike, InsertedMedia } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, Xfrm } from "../core/presentation/model"
import type { SmartArtInfo } from "../core/smartart/edit"
import { mediaCapability } from "../dom/presentation/engine/media"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { CORPUS_DIR } from "./corpusDir"
import { smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"

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
const STEP_LIMIT = 500

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
