import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource, ZipArchive } from "@filen/office/core/opc"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { review } from "../dom/presentation/engine/review"
import { smartartCapability, smartArtRenderer } from "../dom/presentation/engine/smartart"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"
import { image } from "./presentationObjectsFixtures"
import type { SmartArtInfo } from "../core/smartart/edit"

// Diagrams on duplicated, deleted and redone slides across saves, undo-all, redo-all and the history letting go: every
// save is written whole (each diagram's data names a drawing its slide relates), the frames name the parts written, and
// once the history is gone no part the session wrote is left that nothing relates.

type Drive = Awaited<ReturnType<typeof driveSession>>

const PIE = join(CORPUS_DIR, "pptx", "lo__tdf149551_SmartArt_Pie.pptx")
const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
const STEP_LIMIT = 500

function synthetic(): Uint8Array {
	return buildPptx({
		slides: [0, 1, 2].map(at => ({
			shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para(`S${String(at)}`)))
		}))
	})
}

async function session(bytes: Uint8Array): Promise<Drive> {
	const d = await driveSession(bytes, "pptx")

	smartArtRenderer(d.session, {
		services: { xml: part => pptxParts(d.session.deck)?.document(part), relationship: () => undefined, contentType: () => undefined }
	})

	return d
}

function frameIn(shapes: readonly ShapeNode[]): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.frame?.kind === "smartart") return shape

		const child = shape.children === undefined ? undefined : frameIn(shape.children)

		if (child !== undefined) return child
	}

	return undefined
}

async function command(d: Drive, op: DeckOp): Promise<void> {
	if ("slide" in op && typeof op.slide === "number") await review(d.context, op.slide)

	expect((await d.command(op)).ok, `${op.family}.${op.kind}`).toBe(true)
}

// The slide a duplicate of `slide` made.
async function duplicate(d: Drive, slide: SlideRef): Promise<SlideRef> {
	const before = new Set(d.session.deck.slides)

	await command(d, { family: "slide", kind: "duplicate", slide })

	return d.session.deck.slides.find(ref => !before.has(ref)) as SlideRef
}

// The parts this session wrote (with no source: any part) that nothing relates.
async function unrelated(bytes: Uint8Array, source?: Uint8Array): Promise<string[]> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const had = new Set(source === undefined ? [] : (await ZipArchive.open(bytesSource(source))).entries.map(entry => entry.name))
	let rels = ""

	for (const entry of zip.entries) if (entry.name.endsWith(".rels")) rels += new TextDecoder().decode(await zip.read(entry))

	return zip.entries
		.map(entry => entry.name)
		.filter(
			name => /^ppt\/(?:media|diagrams)\/[^/]+$/u.test(name) && !had.has(name) && !rels.includes(`/${name.split("/").pop() ?? ""}"`)
		)
}

async function written(d: Drive): Promise<Uint8Array> {
	const result = await d.save()

	expect(result.result).toEqual(expect.objectContaining({ kind: "written" }))

	if (result.bytes === undefined) throw new Error("not saved")

	expect(await danglingReferences(result.bytes)).toEqual([])

	return result.bytes
}

// Undo everything, save, redo everything, let the history go, save: written whole, nothing left unrelated.
// The text of each diagram part slide `slide` relates, by relationship type, in the file `bytes`.
async function diagramOf(bytes: Uint8Array, slide: string): Promise<string[]> {
	const zip = await ZipArchive.open(bytesSource(bytes))
	const text = async (name: string): Promise<string> => {
		const entry = zip.get(name)

		return entry === undefined ? "missing" : new TextDecoder().decode(await zip.read(entry))
	}
	const rels = await text(slide.replace(/slides\/(slide\d+\.xml)$/u, "slides/_rels/$1.rels"))
	const out: string[] = []

	for (const [relationship] of rels.matchAll(/<Relationship [^>]*\/>/gu)) {
		const type = /\/(diagram[A-Za-z]+)"/u.exec(relationship)?.[1]
		const target = /Target="\.\.\/([^"]+)"/u.exec(relationship)?.[1]

		if (type !== undefined && target !== undefined) out.push(`${type} ${await text(`ppt/${target}`)}`)
	}

	return out.sort()
}

async function aroundTheHistory(d: Drive, source: Uint8Array): Promise<Uint8Array> {
	let undone = 0

	while (undone < 600 && (await d.undo()).ok) undone++

	// Written whole, or nothing to write (undone to the state the last save wrote).
	const back = await d.save()

	if (back.result.kind !== "unchanged") {
		expect(back.result).toEqual(expect.objectContaining({ kind: "written" }))
		expect(await danglingReferences(back.bytes ?? new Uint8Array(0))).toEqual([])
	}

	for (let step = 0; step < undone; step++) expect((await d.redo()).ok).toBe(true)

	const first = d.session.deck.slides[0] as SlideRef

	for (let at = 0; at <= STEP_LIMIT; at++) await command(d, { family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

	const end = await written(d)

	expect(await unrelated(end, source)).toEqual([])

	return end
}

const notes = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })
const diagram = (slide: SlideRef, layout: string): DeckOp => ({
	family: "smartart",
	kind: "insert",
	slide,
	shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: BOX } as ShapeNode,
	layout: { uniqueId: `urn:filen:smartart:layout:${layout}`, source: "gallery" },
	texts: ["Alpha", "Beta", "Gamma"]
})

describe("diagrams across duplicates, deletes and the history", () => {
	it.skipIf(!existsSync(PIE))(
		"a diagram's slide moved and saved, copied, deleted and its copy copied, diagrams inserted on both copies across saves, undone to the start: every save whole, the file's diagram again",
		async () => {
			const source = new Uint8Array(readFileSync(PIE))
			const d = await session(source)
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode
			const copy = await duplicate(d, slide)

			await command(d, { family: "shape", kind: "setXfrm", target: { slide, id: frame.id }, xfrm: { ...BOX, x: 1_452_827 } })
			await written(d)
			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })
			await command(d, diagram(copy, "process-basic"))
			await command(d, { family: "slide", kind: "delete", slides: [slide] })

			const again = await duplicate(d, copy)

			await written(d)
			await command(d, diagram(again, "process-basic"))
			await written(d)

			let undone = 0

			while (undone < 50 && (await d.undo()).ok) undone++

			const back = await written(d)

			expect(await diagramOf(back, "ppt/slides/slide1.xml")).toEqual(await diagramOf(source, "ppt/slides/slide1.xml"))
			await command(d, { family: "slide", kind: "hide", slides: [d.session.deck.slides[0] as SlideRef], hidden: true })
			await written(d)
		}
	)

	it("a diagram inserted on a slide added since the last save: written whole, and again after another save", async () => {
		const source = synthetic()
		const d = await session(source)
		const first = d.session.deck.slides[0] as SlideRef

		await review(d.context, first)

		const layout = (d.session.deck.nodes.get(first) as SlideNode).parent as SlideRef

		await command(d, { family: "slide", kind: "add", at: 1, layout })

		const added = d.session.deck.slides[1] as SlideRef

		await command(d, diagram(added, "venn"))
		await written(d)
		await command(d, { family: "slide", kind: "add", at: 2, layout })
		await command(d, diagram(d.session.deck.slides[2] as SlideRef, "process-basic"))
		await written(d)
		await aroundTheHistory(d, source)
	})

	it("a diagram inserted on a copy of a copy, saved, then undone, redone and let go: its drawing stays", async () => {
		const source = synthetic()
		const d = await session(source)
		const [, first, third] = d.session.deck.slides as SlideRef[]
		const copy = await duplicate(d, third as SlideRef)
		const other = await duplicate(d, first as SlideRef)

		await command(d, { family: "notes", kind: "setNotes", slide: third as SlideRef, body: notes("Third") })
		await command(d, { family: "notes", kind: "setNotes", slide: other, body: notes("Other") })

		const again = await duplicate(d, copy)

		await command(d, diagram(again, "process-basic"))
		await written(d)
		await command(d, {
			family: "picture",
			kind: "insert",
			slide: third as SlideRef,
			shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
			image: image(40, 8)
		})
		await written(d)
		await aroundTheHistory(d, source)
	})

	it("a diagram inserted and saved, its slide duplicated and the original deleted, saved: let go, nothing left behind", async () => {
		const source = synthetic()
		const d = await session(source)
		const slide = d.session.deck.slides[2] as SlideRef

		await command(d, diagram(slide, "picture-caption-list"))
		await written(d)
		await duplicate(d, slide)
		await command(d, { family: "slide", kind: "delete", slides: [slide] })
		await written(d)
		await aroundTheHistory(d, source)
	})

	for (const deleteOriginal of [true, false])
		for (const midSave of [true, false])
			it.skipIf(!existsSync(PIE))(
				`a file diagram's slide duplicated${deleteOriginal ? ", the original deleted" : ""}${midSave ? ", saved" : ""}, the copy's diagram moved: written`,
				async () => {
					const source = new Uint8Array(readFileSync(PIE))
					const d = await session(source)
					const slide = d.session.deck.slides[0] as SlideRef
					const copy = await duplicate(d, slide)

					if (deleteOriginal) await command(d, { family: "slide", kind: "delete", slides: [slide] })
					if (midSave) await written(d)

					await review(d.context, copy)

					const frame = frameIn((d.session.deck.nodes.get(copy) as SlideNode).shapes) as ShapeNode
					const box = frame.xfrm ?? BOX

					await command(d, {
						family: "shape",
						kind: "setXfrm",
						target: { slide: copy, id: frame.id },
						xfrm: { ...box, x: box.x + 12_700 }
					})
					await written(d)
					await aroundTheHistory(d, source)
				}
			)

	it.skipIf(!existsSync(PIE))(
		"a file diagram's slide copied three times, a gallery diagram on a copy and that copy copied: let go, nothing left behind",
		async () => {
			const source = new Uint8Array(readFileSync(PIE))
			const d = await session(source)
			const slide = d.session.deck.slides[0] as SlideRef

			await duplicate(d, slide)
			await duplicate(d, slide)

			const third = await duplicate(d, slide)

			await command(d, {
				family: "picture",
				kind: "insert",
				slide,
				shape: { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
				image: image(15, 8)
			})
			await command(d, diagram(third, "picture-grid"))
			await duplicate(d, third)
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(PIE))(
		"a copy of a copy of a file diagram's slide, its layout changed and the first copy deleted: let go, nothing left behind",
		async () => {
			const source = new Uint8Array(readFileSync(PIE))
			const d = await session(source)
			const slide = d.session.deck.slides[0] as SlideRef

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)

			await written(d)

			const again = await duplicate(d, copy)

			await command(d, { family: "slide", kind: "delete", slides: [copy] })
			await review(d.context, again)

			const frame = frameIn((d.session.deck.nodes.get(again) as SlideNode).shapes) as ShapeNode

			await command(d, {
				family: "smartart",
				kind: "setLayout",
				target: { slide: again, id: frame.id },
				def: { uniqueId: "urn:filen:smartart:layout:pyramid-basic", source: "gallery" }
			})
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(PIE))(
		"a file diagram's slide with notes copied and saved, both diagrams edited, the original deleted, the copy copied: undone whole",
		async () => {
			const source = new Uint8Array(readFileSync(PIE))
			const d = await session(source)
			const slide = d.session.deck.slides[0] as SlideRef

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)

			await written(d)

			const original = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode

			await command(d, {
				family: "smartart",
				kind: "setLayout",
				target: { slide, id: original.id },
				def: { uniqueId: "urn:filen:smartart:layout:pyramid-basic", source: "gallery" }
			})
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await review(d.context, copy)

			const frame = frameIn((d.session.deck.nodes.get(copy) as SlideNode).shapes) as ShapeNode
			const target = { slide: copy, id: frame.id }

			await command(d, {
				family: "smartart",
				kind: "setLayout",
				target,
				def: { uniqueId: "urn:filen:smartart:layout:picture-grid", source: "gallery" }
			})

			const placeholder = ((await smartartCapability.info(d.session, target)) as SmartArtInfo).pictures?.[0]

			if (placeholder === undefined) throw new Error("no placeholder")

			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target,
				node: placeholder.node,
				placeholder: placeholder.placeholder,
				image: image(21, 10)
			})
			await written(d)
			await duplicate(d, copy)
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	// The file's picture diagram (its data relates pictures of its own), on its first slide.
	const STRIP = join(CORPUS_DIR, "pptx", "lo__smartart-picture-strip.pptx")

	async function strip(): Promise<{ source: Uint8Array; d: Drive; slide: SlideRef; frame: ShapeNode }> {
		const source = new Uint8Array(readFileSync(STRIP))
		const d = await session(source)
		const slide = d.session.deck.slides[0] as SlideRef

		await review(d.context, slide)

		return { source, d, slide, frame: frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode }
	}

	async function picture(d: Drive, slide: SlideRef, frame: ShapeNode, width: number): Promise<void> {
		const target = { slide, id: frame.id }
		const placeholder = ((await smartartCapability.info(d.session, target)) as SmartArtInfo).pictures?.[0]

		if (placeholder === undefined) throw new Error("no placeholder")

		await command(d, {
			family: "smartart",
			kind: "setPicture",
			target,
			node: placeholder.node,
			placeholder: placeholder.placeholder,
			image: image(width, 10)
		})
	}

	const pic = (slide: SlideRef, name: string, width: number): DeckOp => ({
		family: "picture",
		kind: "insert",
		slide,
		shape: { id: 0, name, hidden: false, kind: "pic", xfrm: BOX } as ShapeNode,
		image: image(width, 8)
	})

	function shapeNamed(d: Drive, slide: SlideRef, name: string): ShapeNode {
		return (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === name) as ShapeNode
	}

	it.skipIf(!existsSync(STRIP))(
		"a picture diagram's slide copied, a picture set and saved, the copy's picture replaced, another picture set",
		async () => {
			const { source, d, slide, frame } = await strip()

			await command(d, pic(slide, "Picture", 21))
			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)

			await picture(d, slide, frame, 39)
			await written(d)
			await review(d.context, copy)
			await command(d, {
				family: "picture",
				kind: "replace",
				target: { slide: copy, id: shapeNamed(d, copy, "Picture").id },
				image: image(41, 9)
			})
			await picture(d, slide, frame, 15)
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a picture diagram's picture set, its slide copied and saved, the copy copied and deleted around another picture",
		async () => {
			const { source, d, slide, frame } = await strip()

			await picture(d, slide, frame, 19)
			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)

			await written(d)
			await duplicate(d, copy)
			await picture(d, slide, frame, 29)
			await command(d, { family: "slide", kind: "delete", slides: [copy] })
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a gallery diagram beside a picture diagram, pictures set across a save, the slide copied twice and a copy's picture replaced",
		async () => {
			const { source, d, slide, frame } = await strip()

			await command(d, diagram(slide, "process-basic"))
			await picture(d, slide, frame, 16)
			await written(d)
			await command(d, pic(slide, "Picture", 17))
			await picture(d, slide, frame, 20)
			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)
			const again = await duplicate(d, copy)

			await command(d, pic(again, "Other", 14))
			await review(d.context, again)
			await command(d, {
				family: "picture",
				kind: "replace",
				target: { slide: again, id: shapeNamed(d, again, "Other").id },
				image: image(28, 9)
			})
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a picture diagram's slide copied twice and saved, its style changed, a picture diagram inserted on a copy, a picture set",
		async () => {
			const { source, d, slide, frame } = await strip()
			const copy = await duplicate(d, slide)

			await duplicate(d, slide)
			await written(d)
			await command(d, {
				family: "smartart",
				kind: "setStyle",
				target: { slide, id: frame.id },
				def: { uniqueId: "urn:filen:smartart:style:simple", source: "gallery" }
			})
			await command(d, diagram(copy, "bending-picture-accent-list"))
			await picture(d, slide, frame, 16)
			await written(d)
			await aroundTheHistory(d, source)
		}
	)

	// Every save writes a whole file: no diagram data names a drawing relationship its slide lacks.
	async function whole(d: Drive): Promise<void> {
		await written(d)
	}

	it.skipIf(!existsSync(PIE))(
		"a file diagram restyled, its slide copied and the original deleted, a picture set on the copy: every save whole",
		async () => {
			const source = new Uint8Array(readFileSync(PIE))
			const d = await session(source)
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const frame = frameIn((d.session.deck.nodes.get(slide) as SlideNode).shapes) as ShapeNode

			await command(d, {
				family: "smartart",
				kind: "setStyle",
				target: { slide, id: frame.id },
				def: { uniqueId: "urn:filen:smartart:style:simple", source: "gallery" }
			})

			const copy = await duplicate(d, slide)

			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await whole(d)
			await review(d.context, copy)
			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target: { slide: copy, id: (frameIn((d.session.deck.nodes.get(copy) as SlideNode).shapes) as ShapeNode).id },
				node: "{E3B24448-14D6-4217-98F6-3FF4C71063F1}",
				placeholder: "photo",
				image: image(16, 10)
			})
			await whole(d)

			let undone = 0

			while (undone < 50 && (await d.undo()).ok) undone++

			await whole(d)

			for (let step = 0; step < undone; step++) expect((await d.redo()).ok).toBe(true)

			await whole(d)
			await aroundTheHistory(d, source)
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a picture diagram's picture set and its slide copied, the original deleted, a diagram inserted on the copy, undone, redone and let go: every save whole",
		async () => {
			const { source, d, slide, frame } = await strip()

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })
			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target: { slide, id: frame.id },
				node: "{6C48A404-2A3A-41E9-9551-8F4435666C27}",
				placeholder: "rect2",
				image: image(16, 10)
			})

			const copy = await duplicate(d, slide)

			await whole(d)
			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await whole(d)
			await command(d, diagram(copy, "pyramid-basic"))
			await whole(d)

			let undone = 0

			while (undone < 50 && (await d.undo()).ok) undone++

			await whole(d)

			for (let step = 0; step < undone; step++) expect((await d.redo()).ok).toBe(true)

			const first = d.session.deck.slides[0] as SlideRef

			for (let at = 0; at <= STEP_LIMIT; at++)
				await command(d, { family: "slide", kind: "hide", slides: [first], hidden: at % 2 === 0 })

			await whole(d)
			await command(d, { family: "slide", kind: "hide", slides: [first], hidden: false })
			await whole(d)
			expect((await d.undo()).ok).toBe(true)
			expect(await unrelated(await written(d), source)).toEqual([])
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a picture diagram's slide copied and the original deleted, a picture set on the copy, saved, then undone: every save whole",
		async () => {
			const { source, d, slide, frame } = await strip()

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })

			const copy = await duplicate(d, slide)

			await command(d, { family: "slide", kind: "delete", slides: [slide] })
			await review(d.context, copy)
			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target: { slide: copy, id: frame.id },
				node: "{6C48A404-2A3A-41E9-9551-8F4435666C27}",
				placeholder: "rect2",
				image: image(24, 10)
			})
			await whole(d)
			expect((await d.undo()).ok).toBe(true)
			await whole(d)

			// The file's picture the undo named again goes once the history does.
			expect(await unrelated(await aroundTheHistory(d, source))).toEqual([])
		}
	)

	it.skipIf(!existsSync(STRIP))(
		"a picture set, the slide copied twice and saved, a copy restyled and saved, undone, that copy copied: every save whole",
		async () => {
			const { source, d, slide, frame } = await strip()

			await command(d, { family: "notes", kind: "setNotes", slide, body: notes("Notes") })
			await command(d, {
				family: "smartart",
				kind: "setPicture",
				target: { slide, id: frame.id },
				node: "{6C48A404-2A3A-41E9-9551-8F4435666C27}",
				placeholder: "rect2",
				image: image(13, 10)
			})
			await duplicate(d, slide)

			const copy = await duplicate(d, slide)

			await whole(d)
			await command(d, {
				family: "smartart",
				kind: "setStyle",
				target: { slide: copy, id: frame.id },
				def: { uniqueId: "urn:filen:smartart:style:simple", source: "gallery" }
			})
			await whole(d)
			expect((await d.undo()).ok).toBe(true)
			await duplicate(d, copy)
			await whole(d)
			await aroundTheHistory(d, source)
		}
	)
})
