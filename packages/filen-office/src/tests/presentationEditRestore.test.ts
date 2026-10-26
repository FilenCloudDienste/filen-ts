import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { MessageChannel } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import { bytesSource, parseRelationships, relationshipsPartName, ZipArchive, type ByteSource } from "../core/opc/index"
import { opBytesOf } from "../core/presentation/edit/history"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { SlideRef } from "../core/presentation/model"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { editCapability, sessionEdits } from "../dom/presentation/engine/edit"
import { openPptxCapability, pptxParts } from "../dom/presentation/engine/open/pptx"
import { SAVE_DEPENDENCIES } from "../dom/presentation/engine/save"
import { commitSavedSession, rebasableSource, saveHistoryOf, saveSession } from "../dom/presentation/save"
import { savePortReader, type SavePortEnd } from "../dom/presentation/savePort"
import { CORPUS_DIR } from "./corpusDir"
import { BROKEN_EMITTER, editDeck, editDeckOptions, editHarness, shapeById, SOURCE_EMITTER } from "./presentationEditFixtures"
import { body, buildPptx, DEFAULT_LAYOUTS, para, sp, xfrm, type FixtureOptions } from "./pptxFixtures"

// Slide restore after a save's rebase, inverse shapes of the structure ops, gate 1 on structure ops, and the
// history's accounting and save-time revert.

const CT_COMMENTS = "application/vnd.openxmlformats-officedocument.presentationml.comments+xml"
const COMMENTS =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0" dt="2020-01-01T00:00:00.000" idx="1"><p:pos x="10" y="10"/><p:text>Keep me</p:text></p:cm></p:cmLst>'
const CT_AUTHORS = "application/vnd.openxmlformats-officedocument.presentationml.commentAuthors+xml"
const AUTHORS =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:cmAuthorLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cmAuthor id="0" name="A" initials="A" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>'
const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77,
	0x53, 0xde, 0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0, 0, 3, 1, 1, 0, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0,
	0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])
const PIC =
	'<p:pic><p:nvPicPr><p:cNvPr id="40" name="Picture 39"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId60"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="10" y="10"/><a:ext cx="1000" cy="1000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

// A file store with versioning off: an upload replaces the file, and the old version is gone.
class Drive {
	readonly files = new Map<string, Uint8Array>()
	current = "v1"
	private next = 1

	constructor(bytes: Uint8Array) {
		this.files.set("v1", bytes)
	}

	source(uuid: string): ByteSource {
		const of = (): Uint8Array => {
			const bytes = this.files.get(uuid)

			if (bytes === undefined) throw new Error(`gone ${uuid}`)

			return bytes
		}

		return { size: of().length, read: (offset, length) => Promise.resolve(of().slice(offset, offset + length)) }
	}

	async upload(port: InstanceType<typeof MessageChannel>["port1"]): Promise<string> {
		const reader = savePortReader(port as unknown as SavePortEnd)
		const chunks: Uint8Array[] = []

		for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

		const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
		let at = 0

		for (const chunk of chunks) {
			out.set(chunk, at)
			at += chunk.length
		}

		const uuid = `v${String(++this.next)}`

		this.files.set(uuid, out)
		this.files.delete(this.current)
		this.current = uuid
		reader.settled(true)

		return uuid
	}
}

async function driveSession(bytes: Uint8Array) {
	const drive = new Drive(bytes)
	const outcome = await openPptxCapability.open({
		source: rebasableSource(drive.source("v1")),
		sourceKind: "range",
		options: { format: "pptx", fileName: "deck.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "deck.pptx" },
		services: SERVICES,
		rangeSource: spec => drive.source((spec.port as unknown as { uuid: string }).uuid),
		schedule: () => undefined,
		emit: () => undefined,
		onClose: () => undefined
	}
	const context: CallContext = {
		session,
		signal: { aborted: false, onAbort: () => undefined },
		lane: "background",
		slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
	}
	const save = async () => {
		const { port1, port2 } = new MessageChannel()
		const uploading = drive.upload(port2)
		const result = await saveSession(context, { reason: "user", port: port1 as unknown as SavePortEnd }, SAVE_DEPENDENCIES)
		const uuid = result.kind === "written" ? await uploading : undefined

		port1.close()
		port2.close()

		if (result.kind === "written" && uuid !== undefined) {
			await commitSavedSession(
				context,
				{
					file: { uuid, name: "deck.pptx" },
					port: { uuid, postMessage: () => undefined, close: () => undefined } as never,
					size: drive.files.get(uuid)?.length ?? 0,
					revision: result.revision
				},
				SAVE_DEPENDENCIES
			)
		}

		return { result, bytes: uuid === undefined ? undefined : drive.files.get(uuid) }
	}

	return { drive, session, context, save, command: (op: DeckOp) => editCapability.command(context, op) }
}

async function entries(bytes: Uint8Array): Promise<Map<string, string>> {
	const archive = await ZipArchive.open(bytesSource(bytes))
	const out = new Map<string, string>()

	for (const entry of archive.entries) out.set(entry.name, new TextDecoder().decode(await archive.read(entry)))

	return out
}

// Every internal relationship of every part names a part the package has.
function danglingTargets(files: ReadonlyMap<string, string>): string[] {
	const out: string[] = []

	for (const [name, xml] of files) {
		const match = /^(.*\/)?_rels\/([^/]+)\.rels$/u.exec(name)

		if (match === null) continue

		const source = `${match[1] ?? ""}${match[2] ?? ""}`

		if (source !== "" && !files.has(source)) out.push(`orphan rels ${name}`)

		for (const relationship of parseRelationships(new TextEncoder().encode(xml), source).all) {
			if (relationship.external || relationship.partName === undefined) continue
			if (!files.has(relationship.partName)) out.push(`${source} -> ${relationship.partName}`)
		}
	}

	return out
}

// Slide 2 of the edit deck with notes, comments and a picture only it shows.
function richDeck(): FixtureOptions {
	const options = editDeckOptions()

	return {
		...options,
		slides: options.slides.map((slide, index) =>
			index === 1
				? {
						...slide,
						shapes: slide.shapes + PIC,
						notes: para("Second notes"),
						rels: [
							...(slide.rels ?? []),
							["rId50", "comments", "../comments/comment1.xml"] as const,
							["rId60", "image", "../media/image9.png"] as const
						]
					}
				: slide
		),
		defaults: '<Default Extension="png" ContentType="image/png"/>',
		parts: {
			"ppt/comments/comment1.xml": { data: COMMENTS, type: CT_COMMENTS },
			"ppt/commentAuthors.xml": { data: AUTHORS, type: CT_AUTHORS },
			"ppt/media/image9.png": { data: PNG }
		},
		presentationRels: [["rId90", "commentAuthors", "commentAuthors.xml"]]
	}
}

describe("slide restore after a save", () => {
	it("undoes a slide delete after the save that removed the slide", async () => {
		const h = await driveSession(editDeck())
		const deck = h.session.deck
		const target = deck.slides[1] as SlideRef

		await pptxParts(deck)?.slide(target)
		expect(await h.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })
		expect((await h.save()).result).toMatchObject({ kind: "written" })
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true, dirty: true })
		expect(deck.slides[1]).toBe(target)
	})

	it("holds the slide, every part it owns and the shared parts its delete removes", async () => {
		const h = await driveSession(buildPptx(richDeck()))
		const deck = h.session.deck
		const target = deck.slides[1] as SlideRef

		await pptxParts(deck)?.slide(target)
		expect(await h.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })

		const restore = sessionEdits(h.session).history.peekUndo()?.inverse.ops[0]
		const names = restore?.family === "slide" && restore.kind === "restore" ? restore.slides[0]?.parts.map(part => part.name) : []

		expect(names).toEqual([
			"/ppt/slides/slide2.xml",
			"/ppt/comments/comment1.xml",
			"/ppt/notesSlides/notesSlide2.xml",
			"/ppt/media/image9.png"
		])
	})

	it("gives the restored slide and its notes part names nothing else has", async () => {
		const h = await driveSession(buildPptx(richDeck()))
		const deck = h.session.deck
		const target = deck.slides[1] as SlideRef

		await pptxParts(deck)?.slide(target)
		await h.command({ family: "slide", kind: "delete", slides: [target] })
		await h.save()
		// A slide added after the save takes the next free slide number.
		expect(await h.command({ family: "slide", kind: "add", at: 0, layout: deck.layouts[0] as SlideRef })).toMatchObject({ ok: true })

		const added = deck.nodes.get(deck.slides[0] as SlideRef)?.part

		await editCapability.undo(h.context)
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true })

		const slide = deck.nodes.get(target)
		const notes = slide?.notes === undefined ? undefined : deck.nodes.get(slide.notes)
		const others = [...deck.nodes.values()].filter(node => node !== slide && node !== notes).map(node => node.part.toLowerCase())

		expect(slide?.src?.part.startsWith("raw:")).toBe(true)
		expect(others).not.toContain(slide?.part.toLowerCase())
		expect(others).not.toContain(notes?.part.toLowerCase())
		expect(pptxParts(deck)?.opc.has(slide?.part ?? "")).toBe(false)
		expect(slide?.part).not.toBe(added)
		expect(
			sessionEdits(h.session)
				.rawParts(slide?.src?.part ?? "")
				?.map(part => part.name)
		).toEqual(["/ppt/slides/slide2.xml", "/ppt/comments/comment1.xml", "/ppt/notesSlides/notesSlide2.xml", "/ppt/media/image9.png"])
	})

	it("a slide deleted, saved and restored by undo saves with its notes, comments and picture", async () => {
		const h = await driveSession(buildPptx(richDeck()))
		const deck = h.session.deck
		const target = deck.slides[1] as SlideRef

		await pptxParts(deck)?.slide(target)
		expect(await h.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })

		const first = await h.save()

		expect(first.result).toMatchObject({ kind: "written" })

		const deleted = await entries(first.bytes as Uint8Array)

		expect([deleted.has("ppt/comments/comment1.xml"), deleted.has("ppt/media/image9.png")]).toEqual([false, false])
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true, dirty: true })

		const second = await h.save()

		expect(second.result).toMatchObject({ kind: "written" })

		const files = await entries(second.bytes as Uint8Array)

		expect(danglingTargets(files)).toEqual([])

		const slidePart = /<p:sldId [^>]*r:id="([^"]+)"/gu
		const presentationRels = parseRelationships(
			new TextEncoder().encode(files.get("ppt/_rels/presentation.xml.rels") ?? ""),
			"ppt/presentation.xml"
		)
		const order = [...(files.get("ppt/presentation.xml") ?? "").matchAll(slidePart)].map(
			match => presentationRels.byId(match[1] ?? "")?.partName
		)
		const restored = order[1] as string
		const rels = parseRelationships(new TextEncoder().encode(files.get(relationshipsPartName(restored)) ?? ""), restored).all
		const target2 = (kind: string): string => files.get(rels.find(rel => rel.type.endsWith(`/${kind}`))?.partName ?? "") ?? ""

		expect(files.get(restored)).toContain("Second")
		expect(target2("notesSlide")).toContain("Second notes")
		expect(target2("comments")).toContain("Keep me")
		expect(rels.some(rel => rel.type.endsWith("/image") && files.has(rel.partName ?? ""))).toBe(true)

		// And it opens again with them.
		expect(order).toHaveLength(4)
		writeForOracle(second.bytes as Uint8Array)
	})

	it("refuses the undo when a shared part too large to hold is gone after the save", async () => {
		const big = new Uint8Array(17 * 1024 * 1024)

		big.set(PNG)

		const options = richDeck()
		const h = await driveSession(buildPptx({ ...options, parts: { ...options.parts, "ppt/media/image9.png": { data: big } } }))
		const deck = h.session.deck
		const target = deck.slides[1] as SlideRef

		await pptxParts(deck)?.slide(target)
		await h.command({ family: "slide", kind: "delete", slides: [target] })
		// Before the save the picture is still in the package: the undo works.
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true, dirty: false })
		await editCapability.redo(h.context)
		await h.save()
		expect(await editCapability.undo(h.context)).toEqual({ ok: false, refusal: "stale" })
		expect(deck.slides).not.toContain(target)
	}, 60_000)
})

// Optional oracle hand-off: the restored package is written where an Open XML SDK run picks it up.
function writeForOracle(bytes: Uint8Array, name?: string): void {
	const out = process.env["P5_ORACLE_OUT"]

	if (out !== undefined) writeFileSync(name === undefined ? out : `${out}-${name}.pptx`, bytes)
}

describe("structure op inverses", () => {
	it("undo of a multi-slide move restores the original order and reads clean", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const order = [...deck.slides]

		expect(await harness.command({ family: "slide", kind: "move", slides: [order[1], order[3]] as SlideRef[], to: 0 })).toMatchObject({
			ok: true
		})
		expect(deck.slides).toEqual([order[1], order[3], order[0], order[2]])
		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		expect(deck.slides).toEqual(order)
		expect(deck.sections.map(section => section.slides)).toEqual([order.slice(0, 2), order.slice(2)])
		harness.close()
	})

	it("undo of a layout change leaves placeholders the change did not re-number as they were", async () => {
		const bytes = buildPptx({
			layouts: [
				DEFAULT_LAYOUTS[0] as never,
				{
					name: "Seven",
					type: "obj",
					shapes: sp(2, "Title 1", 'type="title"') + sp(3, "Body 7", 'type="body" idx="7"', xfrm(10, 10, 100, 100))
				}
			],
			slides: [
				{
					shapes:
						sp(2, "Title 1", 'type="title"', "", body(para("T"))) + sp(3, "Body", 'type="body" idx="7"', "", body(para("B")))
				},
				{ shapes: "" }
			]
		})
		const harness = await editHarness(bytes)
		const deck = harness.session.deck
		const slide = await harness.slide(0)
		const before = JSON.stringify(slide.shapes.map(shape => shape.ph))

		expect(
			await harness.command({ family: "slide", kind: "setLayout", slide: slide.ref, layout: deck.layouts[1] as SlideRef })
		).toMatchObject({
			ok: true
		})
		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		expect(JSON.stringify(deck.nodes.get(slide.ref)?.shapes.map(shape => shape.ph))).toBe(before)
		harness.close()
	})
})

describe("gate 1 on structure ops", () => {
	it("proves the children of a group whose own proof failed", async () => {
		// The group fails (its markup is not what the emitter writes); its children prove on their own.
		const groupFails = ((family, request, context) =>
			request.shape?.kind === "grpSp"
				? BROKEN_EMITTER(family, request, context)
				: SOURCE_EMITTER(family, request, context)) as typeof SOURCE_EMITTER
		const harness = await editHarness(editDeck(), { emit: groupFails })
		const slide = await harness.slide(0)
		const setFill = (id: number) =>
			harness.command({
				family: "shape",
				kind: "setProps",
				target: { slide: slide.ref, id },
				props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } } } as never
			})

		expect(await setFill(7)).toMatchObject({ ok: true })
		expect({ group: shapeById(slide.shapes, 6)?.lock, child: shapeById(slide.shapes, 7)?.lock }).toEqual({
			group: "proofFailed",
			child: undefined
		})
		harness.close()

		// When everything fails, the children are locked too.
		const broken = await editHarness(editDeck(), { emit: BROKEN_EMITTER })
		const first = await broken.slide(0)

		expect(
			await broken.command({
				family: "shape",
				kind: "setProps",
				target: { slide: first.ref, id: 7 },
				props: { fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } } } as never
			})
		).toEqual({ ok: false, refusal: "locked" })
		expect(shapeById(first.shapes, 7)?.lock).toBe("proofFailed")
		broken.close()
	})

	it("refuses to delete a slide a locked shape jumps to, and proves the jumping slide first", async () => {
		const harness = await editHarness(editDeck(), { emit: BROKEN_EMITTER })
		const deck = harness.session.deck
		const target = deck.slides[2] as SlideRef

		// The jumping slide (the first) is not parsed yet: the delete parses and proves it.
		expect(await harness.command({ family: "slide", kind: "delete", slides: [target] })).toEqual({ ok: false, refusal: "locked" })

		const first = deck.nodes.get(deck.slides[0] as SlideRef)

		expect({ lock: shapeById(first?.shapes ?? [], 5)?.lock, action: shapeById(first?.shapes ?? [], 5)?.actions?.click }).toEqual({
			lock: "proofFailed",
			action: { kind: "slide", slide: target }
		})
		expect(deck.slides).toContain(target)
		harness.close()
	})

	it("a locked shape that still moves keeps moving on a duplicated slide", async () => {
		const harness = await editHarness(editDeck(), { emit: BROKEN_EMITTER })
		const deck = harness.session.deck
		const slide = await harness.slide(1)

		expect(await harness.command({ family: "slide", kind: "duplicate", slide: slide.ref })).toMatchObject({ ok: true })

		const copy = deck.slides[2] as SlideRef

		expect(shapeById(deck.nodes.get(copy)?.shapes ?? [], 2)?.lock).toBe("proofFailed")
		expect(
			await harness.command({
				family: "shape",
				kind: "setXfrm",
				target: { slide: copy, id: 3 },
				xfrm: { x: 10, y: 10, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }
			})
		).toMatchObject({ ok: true })
		harness.close()
	})
})

describe("history accounting", () => {
	it("counts an inverse's typed values, and alt text is undone by its typed value", async () => {
		const paragraphs = Array.from({ length: 400 }, (_, index) => para(`Paragraph ${String(index)} with some words in it`)).join("")
		const bytes = buildPptx({
			slides: [
				{
					shapes: sp(
						3,
						"Big",
						undefined,
						`${xfrm(0, 0, 1000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(paragraphs)
					)
				},
				{ shapes: "" }
			]
		})
		const harness = await editHarness(bytes)
		const slide = await harness.slide(0)
		const history = sessionEdits(harness.session).history

		await harness.command({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: 3 }, alt: { descr: "x" } })

		const altStep = history.peekUndo()

		expect(altStep?.inverse.ops.map(op => op.kind)).toEqual(["setAlt"])
		expect(history.size.bytes).toBeLessThan(16 * 1024)

		await harness.command({ family: "shape", kind: "setProps", target: { slide: slide.ref, id: 3 }, props: { fill: "none" } as never })

		const step = history.peekUndo()
		const typed = (step?.inverse.ops ?? []).reduce((sum, op) => sum + opBytesOf(op), 0)

		// The replacement holds the whole shape: its typed copy counts, not only its markup.
		expect(step?.inverse.ops.map(op => op.kind)).toEqual(["delete", "insert"])
		expect(step?.bytes ?? 0).toBeGreaterThanOrEqual(typed)
		expect(typed).toBeGreaterThan(
			2 *
				(step?.inverse.ops[1]?.family === "shape" && step.inverse.ops[1].kind === "insert"
					? (step.inverse.ops[1].raw?.length ?? 0)
					: 0)
		)
		expect(await harness.undo()).toMatchObject({ ok: true })
		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		harness.close()
	})
})

describe("save-time revert", () => {
	it("reverts only the steps that touch the refused parts and keeps newer edits on other slides", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const first = await harness.slide(0)
		const second = await harness.slide(1)
		const box = { x: 7, y: 7, cx: 70, cy: 70, rot: 0, flipH: false, flipV: false }

		await harness.command({ family: "shape", kind: "setXfrm", target: { slide: first.ref, id: 3 }, xfrm: box })
		await harness.command({ family: "shape", kind: "setXfrm", target: { slide: second.ref, id: 2 }, xfrm: box })

		const reverted = await saveHistoryOf(deck)?.revert?.(new Set([first.part]))

		expect(reverted).toBe(1)
		expect(shapeById(deck.nodes.get(first.ref)?.shapes ?? [], 3)?.xfrm).toEqual({
			x: 100,
			y: 100,
			cx: 1000,
			cy: 500,
			rot: 0,
			flipH: false,
			flipV: false
		})
		expect(shapeById(deck.nodes.get(second.ref)?.shapes ?? [], 2)?.xfrm).toEqual(box)
		expect([...sessionEdits(harness.session).changes().parts.keys()]).toEqual([second.part])
		harness.close()
	})
})

describe("reference graph", () => {
	it("reads only the relationships a save rewrote when the graph is needed again, yielding while it reads", async () => {
		const slides = Array.from({ length: 40 }, (_, index) => ({
			shapes: sp(2, "Title 1", 'type="title"', "", body(para(`Slide ${String(index)}`))),
			notes: para(`n${String(index)}`)
		}))
		const h = await driveSession(buildPptx({ slides }))
		const deck = h.session.deck
		let pauses = 0
		const context: CallContext = {
			...h.context,
			slicing: {
				pause: () => {
					pauses++

					return Promise.resolve()
				},
				sliceMs: 0,
				now: () => 0
			}
		}

		expect(
			await editCapability.command(context, { family: "slide", kind: "delete", slides: [deck.slides[3] as SlideRef] })
		).toMatchObject({ ok: true })
		expect(pauses).toBeGreaterThan(40)
		expect((await h.save()).result).toMatchObject({ kind: "written" })

		const opc = pptxParts(deck)?.opc

		if (opc === undefined) throw new Error("no package")

		let reads = 0
		const relationships = opc.relationships.bind(opc)

		opc.relationships = part => {
			reads++

			return relationships(part)
		}
		expect(await h.command({ family: "slide", kind: "delete", slides: [deck.slides[10] as SlideRef] })).toMatchObject({ ok: true })
		// The parts the save rewrote (the presentation's slide list...); the other 80 slides' and notes' are reused.
		expect(reads).toBeLessThan(8)
	})
})

describe("slide delete over a dangling relationship", () => {
	it("deletes a slide whose owned part is missing from the package, also after duplicating it", async () => {
		const options = editDeckOptions()
		const bytes = buildPptx({
			...options,
			slides: options.slides.map((slide, index) =>
				index === 1
					? { ...slide, rels: [...(slide.rels ?? []), ["rId70", "diagramDrawing", "../diagrams/drawing1.xml"] as const] }
					: slide
			)
		})
		const harness = await editHarness(bytes)
		const deck = harness.session.deck
		const target = deck.slides[1] as SlideRef

		await harness.slide(1)
		expect(await harness.command({ family: "slide", kind: "duplicate", slide: target })).toMatchObject({ ok: true })
		expect(await harness.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })
		expect(await harness.undo()).toMatchObject({ ok: true })
		expect(await harness.undo()).toMatchObject({ ok: true, dirty: false })
		harness.close()
	})
})

describe("group moves", () => {
	it("moving a group without a child space writes one that carries its children with it, and the save passes", async () => {
		const group =
			'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 9"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1000" y="1000"/><a:ext cx="2000" cy="1000"/></a:xfrm></p:grpSpPr>' +
			sp(11, "Inner", undefined, `${xfrm(1000, 1000, 1000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
			sp(12, "Inner 2", undefined, `${xfrm(2000, 1000, 1000, 1000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`) +
			"</p:grpSp>"
		const h = await driveSession(buildPptx({ slides: [{ shapes: group }, { shapes: "" }] }))
		const deck = h.session.deck
		const slide = await pptxParts(deck)?.slide(deck.slides[0] as SlideRef)

		if (slide === undefined) throw new Error("no slide")

		const moved = { x: 5000, y: 3000, cx: 4000, cy: 2000, rot: 0, flipH: false, flipV: false }

		expect(await h.command({ family: "shape", kind: "setXfrm", target: { slide: slide.ref, id: 10 }, xfrm: moved })).toMatchObject({
			ok: true
		})
		expect(shapeById(slide.shapes, 10)?.xfrm).toEqual({ ...moved, chX: 1000, chY: 1000, chCx: 2000, chCy: 1000 })

		const saved = await h.save()

		expect(saved.result).toMatchObject({ kind: "written" })
		expect((await entries(saved.bytes as Uint8Array)).get("ppt/slides/slide1.xml")).toContain(
			'<a:chOff x="1000" y="1000"/><a:chExt cx="2000" cy="1000"/>'
		)
	})
})

describe("inherited damage on restore", () => {
	const file = join(CORPUS_DIR, "pptx/lo__smartart-autoTxRot.pptx")

	it.skipIf(!existsSync(file))("restores a slide whose source relationship already dangles exactly as the source had it", async () => {
		const source = new Uint8Array(readFileSync(file))
		const h = await driveSession(source)
		const deck = h.session.deck
		const target = deck.slides[0] as SlideRef
		const relationshipsIn = (files: ReadonlyMap<string, string>, part: string): string[] =>
			parseRelationships(new TextEncoder().encode(files.get(relationshipsPartName(part)) ?? ""), part)
				.all.map(
					relationship => `${relationship.type} ${relationship.external ? relationship.target : (relationship.partName ?? "")}`
				)
				.sort()

		await pptxParts(deck)?.slide(target)
		expect(await h.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })
		expect((await h.save()).result).toMatchObject({ kind: "written" })
		expect(await editCapability.undo(h.context)).toMatchObject({ ok: true })

		const saved = await h.save()

		expect(saved.result).toMatchObject({ kind: "written" })
		writeForOracle(saved.bytes as Uint8Array)

		const before = await entries(source)
		const after = await entries(saved.bytes as Uint8Array)
		const restored = deck.nodes.get(target)?.part.slice(1) ?? ""
		// Owned parts are written under new names: compare by kind and whether the target exists.
		const shape = (files: ReadonlyMap<string, string>, part: string): string[] =>
			relationshipsIn(files, part).map(line => {
				const [type = "", name = ""] = line.split(" ")

				return `${type.slice(type.lastIndexOf("/") + 1)} ${files.has(name) ? "present" : "missing"}`
			})

		expect(shape(after, restored)).toEqual(shape(before, "ppt/slides/slide1.xml"))
		expect(shape(after, restored)).toContain("diagramDrawing missing")
	})
})

// Each listed slide of a saved file: its text, its notes' text, its comments' text and whether its picture is there.
async function slideSignatures(bytes: Uint8Array): Promise<string[]> {
	const files = await entries(bytes)
	const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
	const textOf = (xml: string | undefined): string =>
		[...(xml ?? "").matchAll(/<(?:a|p):t>([^<]*)<\/(?:a|p):t>/gu)].map(match => match[1]).join("|")
	const presentation = parseRelationships(encode(files.get("ppt/_rels/presentation.xml.rels") ?? ""), "ppt/presentation.xml")

	return [...(files.get("ppt/presentation.xml") ?? "").matchAll(/<p:sldId [^>]*r:id="([^"]+)"/gu)].map(match => {
		const part = presentation.byId(match[1] ?? "")?.partName ?? ""
		const rels = parseRelationships(encode(files.get(relationshipsPartName(part)) ?? ""), part).all
		const target = (kind: string): string | undefined => rels.find(rel => rel.type.endsWith(`/${kind}`))?.partName
		const picture = target("image")

		return [
			textOf(files.get(part)),
			`n:${textOf(files.get(target("notesSlide") ?? ""))}`,
			`c:${textOf(files.get(target("comments") ?? ""))}`,
			`p:${picture === undefined ? "-" : String(files.has(picture))}`
		].join(" ")
	})
}

describe("restore chains across saves", () => {
	for (const again of ["command", "redo"] as const) {
		it(`a slide deleted again (${again}) after its restore was saved comes back whole from the next undo`, async () => {
			const h = await driveSession(buildPptx(richDeck()))
			const deck = h.session.deck
			const target = deck.slides[1] as SlideRef
			const original = await slideSignatures(buildPptx(richDeck()))

			await pptxParts(deck)?.slide(target)
			await h.command({ family: "slide", kind: "delete", slides: [target] })
			await h.save()
			await editCapability.undo(h.context)
			await h.save()

			if (again === "redo") expect(await editCapability.redo(h.context)).toMatchObject({ ok: true })
			else expect(await h.command({ family: "slide", kind: "delete", slides: [target] })).toMatchObject({ ok: true })

			expect((await h.save()).result).toMatchObject({ kind: "written" })
			expect(await editCapability.undo(h.context)).toMatchObject({ ok: true })

			const saved = await h.save()

			expect(saved.result).toMatchObject({ kind: "written" })
			expect(await slideSignatures(saved.bytes as Uint8Array)).toEqual(original)
			expect(danglingTargets(await entries(saved.bytes as Uint8Array))).toEqual([])
		})
	}

	it("random delete, undo, redo and save sequences keep every slide's parts in every save", { timeout: 300_000 }, async () => {
		const source = buildPptx(richDeck())
		const original = await slideSignatures(source)
		let saves = 0

		for (let seed = 1; seed <= 40; seed++) {
			let state = seed * 2_654_435_761

			const next = (): number => {
				state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

				return state / 4_294_967_296
			}
			const h = await driveSession(source)
			const deck = h.session.deck
			const signature = new Map(deck.slides.map((ref, index) => [ref, original[index] ?? ""]))
			let saved = 0

			for (let step = 0; step < 24 || saved < 3; step++) {
				const roll = next()

				if (roll < 0.3 && deck.slides.length > 1) {
					// The slide with notes, comments and a picture most of the time.
					const rich = deck.slides.find(ref => signature.get(ref)?.includes("Second notes") === true)
					const ref = (
						rich !== undefined && next() < 0.6 ? rich : deck.slides[Math.floor(next() * deck.slides.length)]
					) as SlideRef

					await pptxParts(deck)?.slide(ref)
					await h.command({ family: "slide", kind: "delete", slides: [ref] })
				} else if (roll < 0.5) {
					await editCapability.undo(h.context)
				} else if (roll < 0.65) {
					await editCapability.redo(h.context)
				} else {
					const result = await h.save()

					if (result.result.kind === "unchanged") continue

					expect({ seed, step, result: result.result.kind }).toEqual({ seed, step, result: "written" })

					const bytes = result.bytes as Uint8Array

					expect({ seed, step, slides: await slideSignatures(bytes) }).toEqual({
						seed,
						step,
						slides: deck.slides.map(ref => signature.get(ref))
					})
					expect(danglingTargets(await entries(bytes))).toEqual([])
					writeForOracle(bytes, `${String(seed)}-${String(step)}`)
					saved++
					saves++
				}
			}
		}

		expect(saves).toBeGreaterThanOrEqual(120)
	})
})

describe("ops on missing targets", () => {
	it("refuses every slide and shape op that names a slide or shape the deck does not have, and pushes no step", async () => {
		const harness = await editHarness(editDeck())
		const deck = harness.session.deck
		const first = await harness.slide(0)
		const second = await harness.slide(1)

		expect(await harness.command({ family: "slide", kind: "delete", slides: [second.ref] })).toMatchObject({ ok: true })

		const history = sessionEdits(harness.session).history
		const steps = history.size.steps
		const revision = history.revision
		const gone = second.ref
		const missing = 0x7fff_0000 as SlideRef
		const box = { x: 1, y: 1, cx: 1, cy: 1, rot: 0, flipH: false, flipV: false }
		const ops: DeckOp[] = [
			{ family: "slide", kind: "delete", slides: [gone] },
			{ family: "slide", kind: "delete", slides: [first.ref, gone] },
			{ family: "slide", kind: "delete", slides: [] },
			{ family: "slide", kind: "move", slides: [gone], to: 0 },
			{ family: "slide", kind: "move", slides: [first.ref, gone], to: 2 },
			{ family: "slide", kind: "move", slides: [], to: 0 },
			{ family: "slide", kind: "hide", slides: [gone], hidden: true },
			{ family: "slide", kind: "hide", slides: [], hidden: true },
			{ family: "slide", kind: "duplicate", slide: gone },
			{ family: "slide", kind: "setLayout", slide: gone, layout: deck.layouts[0] as SlideRef },
			{ family: "slide", kind: "setLayout", slide: first.ref, layout: missing },
			{ family: "slide", kind: "reset", slide: gone },
			{ family: "shape", kind: "setXfrm", target: { slide: gone, id: 2 }, xfrm: box },
			{ family: "shape", kind: "setXfrm", target: { slide: first.ref, id: 999 }, xfrm: box },
			{ family: "shape", kind: "delete", slide: first.ref, shapes: [999] },
			{ family: "shape", kind: "delete", slide: first.ref, shapes: [] },
			{ family: "shape", kind: "zOrder", slide: first.ref, shapes: [999], to: "front" },
			{ family: "shape", kind: "zOrder", slide: first.ref, shapes: [], to: "front" },
			{ family: "shape", kind: "align", slide: first.ref, shapes: [999], edge: "left", relativeTo: "slide" },
			{ family: "shape", kind: "align", slide: first.ref, shapes: [], edge: "left", relativeTo: "slide" },
			{ family: "shape", kind: "distribute", slide: first.ref, shapes: [], axis: "horizontal", relativeTo: "slide" },
			{ family: "shape", kind: "group", slide: first.ref, shapes: [3, 999] },
			{ family: "shape", kind: "ungroup", slide: first.ref, group: 999 },
			{ family: "shape", kind: "setAlt", target: { slide: first.ref, id: 999 }, alt: { descr: "x" } }
		]

		for (const op of ops) {
			const result = await harness.command(op)

			expect({ op: JSON.stringify(op), ok: result.ok }).toEqual({ op: JSON.stringify(op), ok: false })
			expect(["notFound", "malformed"]).toContain(result.ok ? "" : result.refusal)
		}

		expect({ steps: history.size.steps, revision: history.revision }).toEqual({ steps, revision })
		harness.close()
	})

	it("an op that changes nothing (aligning one shape to the selection) pushes no step", async () => {
		const harness = await editHarness(editDeck())
		const first = await harness.slide(0)
		const history = sessionEdits(harness.session).history

		expect(
			await harness.command({ family: "shape", kind: "align", slide: first.ref, shapes: [3], edge: "left", relativeTo: "selection" })
		).toMatchObject({ ok: true, dirty: false })
		expect(history.size.steps).toBe(0)
		harness.close()
	})
})
