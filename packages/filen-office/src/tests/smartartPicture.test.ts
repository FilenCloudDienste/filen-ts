import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import { insertedImage, insertedImageWritten } from "../core/presentation/edit/apply/picture"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, ShapeRef, SlideNode } from "../core/presentation/model"
import { diagramOutline, type DiagramOutlineNode, type SmartArtInfo } from "../core/smartart/edit"
import { parseXml } from "../core/xml/index"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { image } from "./presentationObjectsFixtures"
import { danglingReferences } from "./pptxWriteFixtures"

// A picture put into a SmartArt picture placeholder through the engine (apply, relayout, save, commit, rebase): the
// placeholder shows it at once, a save stores the image once and relates it from the diagram's data and drawing, an
// undo past a save brings the earlier picture back (the parts a later save replaced stay, as a replaced picture's image
// does), and a layout switch keeps the picture.

const LAYOUT = "urn:filen:smartart:layout:picture-caption-list"
const SLICING = { pause: () => Promise.resolve(), sliceMs: 1e9, now: () => 0 }

type Drive = Awaited<ReturnType<typeof driveSession>>

function deck(): Uint8Array {
	return buildPptx({
		slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("Title"))) }]
	})
}

async function diagram(): Promise<{ d: Drive; target: ShapeRef }> {
	const d = await driveSession(deck(), "pptx")
	const slide = d.session.deck.slides[0] as SlideNode["ref"]

	smartArtRenderer(d.session, {
		services: { xml: part => pptxParts(d.session.deck)?.document(part), relationship: () => undefined, contentType: () => undefined }
	})

	const inserted = await d.command({
		family: "smartart",
		kind: "insert",
		slide,
		shape: {
			id: 0,
			name: "Diagram",
			hidden: false,
			kind: "frame",
			xfrm: { x: 500_000, y: 900_000, cx: 8_000_000, cy: 4_500_000, rot: 0, flipH: false, flipV: false }
		} as ShapeNode,
		layout: { uniqueId: LAYOUT, source: "gallery" },
		texts: ["Alpha", "Beta"]
	})

	expect(inserted.ok).toBe(true)

	const shape = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.name === "Diagram") as ShapeNode

	return { d, target: { slide, id: shape.id } }
}

async function info(d: Drive, target: ShapeRef): Promise<SmartArtInfo> {
	return smartartCapability.info(d.session, target) as Promise<SmartArtInfo>
}

async function saved(d: Drive): Promise<ZipArchive> {
	const result = await d.save()

	expect(result.result.kind).toBe("written")

	if (result.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(result.bytes)).toEqual([])

	return ZipArchive.open(bytesSource(result.bytes))
}

function names(archive: ZipArchive, pattern: RegExp): string[] {
	return archive.entries.map(entry => entry.name).filter(name => pattern.test(name))
}

async function text(archive: ZipArchive, name: string): Promise<string> {
	const entry = archive.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return new TextDecoder().decode(await archive.read(entry))
}

async function setPicture(d: Drive, target: ShapeRef, width: number): Promise<boolean> {
	const placeholders = (await info(d, target)).pictures ?? []
	const alpha = (await info(d, target)).nodes.find(node => node.text === "Alpha")?.id ?? ""
	const placeholder = placeholders.find(each => each.node === alpha)

	if (placeholder === undefined) throw new Error("no placeholder for Alpha")

	const op: DeckOp = {
		family: "smartart",
		kind: "setPicture",
		target,
		node: alpha,
		placeholder: placeholder.placeholder,
		image: image(width, 16)
	}

	return (await d.command(op)).ok
}

describe("a picture in a SmartArt picture placeholder", () => {
	it("answers the placeholders, one per item, empty until a picture fills one", async () => {
		const { d, target } = await diagram()
		const before = (await info(d, target)).pictures ?? []

		expect(before).toHaveLength(2)
		expect(before.every(each => !each.filled && each.w > 0 && each.h > 0)).toBe(true)
		expect(await setPicture(d, target, 32)).toBe(true)

		const after = (await info(d, target)).pictures ?? []

		expect(after.filter(each => each.filled)).toHaveLength(1)
	})

	it("refuses a placeholder of a node the diagram does not have, typed", async () => {
		const { d, target } = await diagram()
		const result = await d.command({
			family: "smartart",
			kind: "setPicture",
			target,
			node: "{00000000-0000-4000-8000-000000000000}",
			placeholder: "photo",
			image: image(8, 8)
		})

		expect(result).toMatchObject({ ok: false, refusal: "notFound" })
	})

	it("stores the image once, related from the diagram's data and drawing", async () => {
		const { d, target } = await diagram()

		expect(await setPicture(d, target, 32)).toBe(true)

		const file = await saved(d)
		const images = names(file, /^ppt\/media\/.*\.png$/u)

		expect(images).toHaveLength(1)

		const data = names(file, /^ppt\/diagrams\/data\d*\.xml$/u)
		const drawing = names(file, /^ppt\/diagrams\/drawing\d*\.xml$/u)

		expect(data).toHaveLength(1)
		expect(drawing).toHaveLength(1)

		for (const part of [data[0] as string, drawing[0] as string]) {
			const xml = await text(file, part)
			const rels = await text(file, part.replace("diagrams/", "diagrams/_rels/") + ".rels")
			const embed = /r:embed="([^"]+)"/u.exec(xml)?.[1] ?? ""

			expect(embed, part).toMatch(/^rId\d+$/u)
			expect(rels, part).toContain(`Id="${embed}"`)
			expect(rels, part).toContain(images[0]?.replace("ppt/", "../") ?? "?")
			expect(xml, part).not.toContain("inserted:")
		}

		// The registry let go of the bytes: the saved part is the image from now on.
		expect(insertedImage(d.session.deck, 1)).toBeUndefined()
		expect(insertedImageWritten(d.session.deck, 1)?.part).toBeDefined()
	})

	it("replaces the picture after a save, and an undo past the next save brings the first picture back", async () => {
		const { d, target } = await diagram()
		const imageOf = async (file: ZipArchive): Promise<string> => {
			const data = names(file, /^ppt\/diagrams\/data\d*\.xml$/u)
			// The data part the slide's frame names.
			const slide = await text(file, "ppt/slides/slide1.xml")
			const rels = await text(file, "ppt/slides/_rels/slide1.xml.rels")
			const dm = /r:dm="([^"]+)"/u.exec(slide)?.[1] ?? ""
			const part = new RegExp(`Id="${dm}"[^>]*Target="\\.\\./diagrams/([^"]+)"`, "u").exec(rels)?.[1] ?? ""

			expect(data).toContain(`ppt/diagrams/${part}`)

			const embed = /r:embed="([^"]+)"/u.exec(await text(file, `ppt/diagrams/${part}`))?.[1] ?? ""
			const dataRels = await text(file, `ppt/diagrams/_rels/${part}.rels`)

			return new RegExp(`Id="${embed}"[^>]*Target="\\.\\./media/([^"]+)"`, "u").exec(dataRels)?.[1] ?? ""
		}

		expect(await setPicture(d, target, 32)).toBe(true)

		const first = await imageOf(await saved(d))

		expect(await setPicture(d, target, 48)).toBe(true)

		const second = await imageOf(await saved(d))

		expect(second).not.toBe(first)
		expect((await d.undo()).ok).toBe(true)
		expect(await imageOf(await saved(d))).toBe(first)
	})

	it("undoes a picture past a save and redoes it, storing the image once", async () => {
		const { d, target } = await diagram()
		// The picture the slide's diagram shows (its data part's first r:embed), "" for none.
		const shown = async (file: ZipArchive): Promise<string> => {
			const slide = await text(file, "ppt/slides/slide1.xml")
			const rels = await text(file, "ppt/slides/_rels/slide1.xml.rels")
			const dm = /r:dm="([^"]+)"/u.exec(slide)?.[1] ?? ""
			const part = new RegExp(`Id="${dm}"[^>]*Target="\\.\\./diagrams/([^"]+)"`, "u").exec(rels)?.[1] ?? ""
			const embed = /r:embed="([^"]+)"/u.exec(await text(file, `ppt/diagrams/${part}`))?.[1]

			if (embed === undefined) return ""

			return (
				new RegExp(`Id="${embed}"[^>]*Target="\\.\\./media/([^"]+)"`, "u").exec(
					await text(file, `ppt/diagrams/_rels/${part}.rels`)
				)?.[1] ?? "?"
			)
		}

		expect(await setPicture(d, target, 32)).toBe(true)

		const first = await shown(await saved(d))

		expect(first).toMatch(/\.png$/u)
		expect((await d.undo()).ok).toBe(true)
		expect(await shown(await saved(d))).toBe("")
		expect((await d.redo()).ok).toBe(true)

		const file = await saved(d)

		expect(await shown(file)).toBe(first)
		expect(names(file, /^ppt\/media\/.*\.png$/u)).toHaveLength(1)
	})

	it("keeps the picture across a switch to another picture layout and back", async () => {
		const { d, target } = await diagram()

		expect(await setPicture(d, target, 32)).toBe(true)

		for (const uniqueId of ["urn:filen:smartart:layout:picture-grid", LAYOUT]) {
			expect(
				(await d.command({ family: "smartart", kind: "setLayout", target, def: { uniqueId, source: "gallery" } })).ok,
				uniqueId
			).toBe(true)
			expect(
				((await info(d, target)).pictures ?? []).filter(each => each.filled),
				uniqueId
			).toHaveLength(1)
		}

		const file = await saved(d)
		const data = names(file, /^ppt\/diagrams\/data\d*\.xml$/u)[0] as string
		const outline = diagramOutline(parseXml(new TextEncoder().encode(await text(file, data)))) as readonly DiagramOutlineNode[]

		expect(outline.map(each => each.text)).toEqual(["Alpha", "Beta"])
		expect(names(file, /^ppt\/media\/.*\.png$/u)).toHaveLength(1)
	})

	it("relays the diagram out with the picture before the save, and draws it from the slide", async () => {
		const { d, target } = await diagram()

		expect(await setPicture(d, target, 32)).toBe(true)

		const laid = await smartartCapability.relayout(d.session, target, SLICING)
		const pictureShapes = laid.shapes.filter(shape => {
			const fill = shape.props?.fill

			return fill !== undefined && fill !== "none" && fill.kind === "picture" && fill.inserted !== undefined
		})

		expect(pictureShapes).toHaveLength(1)
	})
})
