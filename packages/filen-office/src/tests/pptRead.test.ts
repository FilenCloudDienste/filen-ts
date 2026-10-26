import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openPptFile, readDocument } from "../core/ppt/document"
import type { PptDecryption } from "../core/ppt/decrypt"
import { readCurrentUser, readPersistDirectory } from "../core/ppt/persist"
import { DEFAULT_PPT_BUDGETS, recordAt } from "../core/ppt/records"
import { readSlides } from "../core/ppt/slides"
import { paragraphsOf, readCF, readPF, type TextBlock } from "../core/ppt/text"
import { pptToPptx } from "../core/ppt/toPptx"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { openPptxPackage } from "../core/pptx/package"
import type { Deck, ShapeNode } from "../core/presentation/model"
import { buildPpt, concat, FIXTURE_PNG, record, type FixtureOptions } from "./pptFixtures"

// The PowerPoint 97–2003 reader over synthetic files built to [MS-PPT]: the persist directory and its edit chain,
// the document and slide lists, slides, shapes, text runs and fields, pictures, RC4 CryptoAPI decryption, and the
// pptx it converts to as the pptx reader opens it.

function decryption(password: string): PptDecryption {
	return { password, sha1: data => Promise.resolve(new Uint8Array(createHash("sha1").update(data).digest())) }
}

const TWO_SLIDES: FixtureOptions = {
	slides: [
		{
			shapes: [
				{ text: "Hello", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] },
				{ text: "Box", anchor: [1000, 1000, 2000, 2000] }
			]
		},
		{
			hidden: true,
			shapes: [{ outline: 0, placeholder: { type: 14, position: 1 }, anchor: [900, 300, 5400, 4000] }],
			outline: [{ type: 1, text: "Body\rSecond" }]
		}
	]
}

async function deckOf(options: FixtureOptions, password?: string): Promise<Deck> {
	const built = await buildPpt(options)
	const converted = await pptToPptx(bytesSource(built.bytes), password === undefined ? {} : { decryption: decryption(password) })

	if (converted.kind === "refused") throw new Error(`${converted.reason}: ${converted.detail ?? ""}`)

	const opened = await openPptxPackage(converted.pptx)

	if (opened.kind === "refused") throw new Error(`${opened.reason}: ${opened.detail ?? ""}`)

	await opened.parts.parseAll()

	return opened.deck
}

function textOf(shape: ShapeNode | undefined): string {
	return (shape?.text?.paragraphs ?? [])
		.map(paragraph => paragraph.runs.map(run => (run.kind === "br" ? "\n" : run.text)).join(""))
		.join("\n")
}

function slideShapes(deck: Deck, index: number): readonly ShapeNode[] {
	const ref = deck.slides[index]

	return ref === undefined ? [] : (deck.nodes.get(ref)?.shapes ?? [])
}

describe("ppt persist directory", () => {
	it("reads the newest edit's objects, never the dead record an incremental save left", async () => {
		const built = await buildPpt({
			...TWO_SLIDES,
			edit: {
				index: 0,
				slide: { shapes: [{ text: "Edited", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] }] }
			}
		})
		const file = await openPptFile(bytesSource(built.bytes))

		expect(file.directory.edits).toHaveLength(2)
		expect(file.directory.offsets.get(3)).toBe(built.persist.get(3))

		const deck = await deckOf({
			...TWO_SLIDES,
			edit: {
				index: 0,
				slide: { shapes: [{ text: "Edited", textType: 0, placeholder: { type: 13, position: 0 }, anchor: [100, 300, 5400, 700] }] }
			}
		})

		expect(slideShapes(deck, 0).map(textOf)).toEqual(["Edited"])
	})

	it("refuses an edit chain that loops", () => {
		const le32 = (value: number): Uint8Array => new Uint8Array(Uint32Array.of(value).buffer)
		// §2.3.3 UserEditAtom: lastSlideIdRef, version, offsetLastEdit, offsetPersistDirectory, docPersistIdRef, seed, view.
		const edit = (lastEdit: number): Uint8Array =>
			record(0x0ff5, concat(le32(0), le32(0x03000000), le32(lastEdit), le32(0), le32(1), le32(1), le32(0)))
		// An empty PersistDirectoryAtom at 0, then two edits at 8 and 44 naming each other as the previous one.
		const looping = concat(record(0x1772, new Uint8Array(0)), edit(44), edit(8))

		expect(() => readPersistDirectory(looping, { headerToken: 0, offsetToCurrentEdit: 8 })).toThrow(
			expect.objectContaining({ reason: "malformed" })
		)
	})

	it("refuses more user edits than the budget", async () => {
		const built = await buildPpt({ ...TWO_SLIDES, edit: { index: 0, slide: TWO_SLIDES.slides[0] ?? { shapes: [] } } })
		const file = await openPptFile(bytesSource(built.bytes))
		const user = { headerToken: 0, offsetToCurrentEdit: file.directory.current.offset }

		expect(() => readPersistDirectory(file.stream, user, { ...DEFAULT_PPT_BUDGETS, userEdits: 1 })).toThrow(
			expect.objectContaining({ reason: "tooLarge" })
		)
	})

	it("refuses more records than the budget", async () => {
		const built = await buildPpt(TWO_SLIDES)

		expect(await pptToPptx(bytesSource(built.bytes), { budgets: { ...DEFAULT_PPT_BUDGETS, records: 20 } })).toMatchObject({
			kind: "refused",
			reason: "tooLarge"
		})
	})

	it("holds the converted deck to the presentation budgets: slides, shapes per slide, characters", async () => {
		const built = await buildPpt({
			slides: [
				{
					shapes: [0, 1, 2].map(index => ({ outline: 0, anchor: [index * 100, 0, index * 100 + 50, 50] as const })),
					outline: [{ type: 4, text: "x".repeat(1000) }]
				}
			]
		})
		const source = (): ReturnType<typeof bytesSource> => bytesSource(built.bytes)

		expect(await pptToPptx(source(), { deckBudgets: { ...DEFAULT_PRESENTATION_BUDGETS, slides: 0 } })).toMatchObject({
			kind: "refused",
			reason: "tooLarge"
		})
		expect(await pptToPptx(source(), { deckBudgets: { ...DEFAULT_PRESENTATION_BUDGETS, shapesPerSlide: 3 } })).toMatchObject({
			kind: "refused",
			reason: "tooLarge"
		})
		// One body referenced by three shapes counts three times (the master adds its own 23).
		expect(await pptToPptx(source(), { deckBudgets: { ...DEFAULT_PRESENTATION_BUDGETS, charactersPerDeck: 2500 } })).toMatchObject({
			kind: "refused",
			reason: "tooLarge"
		})
		expect(await pptToPptx(source(), { deckBudgets: { ...DEFAULT_PRESENTATION_BUDGETS, charactersPerDeck: 3100 } })).toMatchObject({
			kind: "converted"
		})
	})

	it("reads the Current User atom", async () => {
		const built = await buildPpt(TWO_SLIDES)
		const file = await openPptFile(bytesSource(built.bytes))
		const user = readCurrentUser(await file.cfb.read("Current User"))

		expect(user.offsetToCurrentEdit).toBe(file.directory.current.offset)
		expect(recordAt(file.stream, user.offsetToCurrentEdit).type).toBe(0x0ff5)
	})
})

describe("ppt document and slides", () => {
	it("lists the slides, their persist objects and outline text", async () => {
		const built = await buildPpt(TWO_SLIDES)
		const document = readDocument(await openPptFile(bytesSource(built.bytes)))
		const slides = readSlides(document)

		expect(document.slideSize).toEqual({ x: 5760, y: 4320 })
		expect(document.fonts.map(font => font.name)).toEqual(["Arial"])
		expect(document.slides.map(entry => entry.id)).toEqual([256, 257])
		expect(document.slides[1]?.texts.map(text => text.text)).toEqual(["Body\rSecond"])
		expect(slides.mainMasters).toHaveLength(1)
		expect(slides.slides.map(slide => slide.show?.hidden ?? false)).toEqual([false, true])
		expect(slides.slides[0]?.drawing.shapes.map(shape => shape.placeholder?.type)).toEqual([13, undefined])
	})

	it("converts to a pptx the reader opens: slides, hidden flags, placeholders, outline text, size", async () => {
		const deck = await deckOf(TWO_SLIDES)

		expect(deck.slides).toHaveLength(2)
		expect(deck.slides.map(ref => deck.nodes.get(ref)?.hidden)).toEqual([false, true])
		expect(deck.size).toMatchObject({ cx: 9144000, cy: 6858000 })
		expect(slideShapes(deck, 0).map(shape => [shape.ph?.type, textOf(shape)])).toEqual([
			["title", "Hello"],
			[undefined, "Box"]
		])
		expect(slideShapes(deck, 1).map(shape => [shape.ph?.type, textOf(shape)])).toEqual([["body", "Body\nSecond"]])
		expect(slideShapes(deck, 0)[1]?.xfrm).toMatchObject({ x: 1587500, y: 1587500, cx: 1587500, cy: 1587500 })
	})

	it("refuses a compound file that is not a presentation, typed", async () => {
		const built = await buildPpt(TWO_SLIDES)
		const { cfbBytes } = await import("../core/cfb/index")
		const word = await cfbBytes([{ path: ["WordDocument"], bytes: new Uint8Array(16) }])

		expect(await pptToPptx(bytesSource(word))).toMatchObject({ kind: "refused", reason: "unsupported" })
		expect(await pptToPptx(bytesSource(built.bytes.subarray(0, 600)))).toMatchObject({ kind: "refused" })
		expect(await pptToPptx(bytesSource(new Uint8Array(100)))).toMatchObject({ kind: "refused", reason: "malformed" })
	})
})

describe("ppt text", () => {
	it("reads paragraph and character exceptions in mask order", () => {
		// PF: bullet flags (on), bullet char '•', align centre, line spacing 120%, left margin 100, indent 50.
		const pf = concat(
			new Uint8Array(Uint32Array.of(0x1 | 0x80 | 0x800 | 0x1000 | 0x100 | 0x400).buffer),
			new Uint8Array(Uint16Array.of(0x1, 0x2022, 1, 120, 100, 50).buffer)
		)
		const read = readPF(pf, 0, pf.length)

		expect(read.pf).toEqual({ bullet: true, bulletChar: 0x2022, align: 1, lineSpacing: 120, leftMargin: 100, indent: 50 })
		expect(read.next).toBe(pf.length)

		// CF: bold + italic, font 2, size 24, colour scheme index 3.
		const cf = concat(
			new Uint8Array(Uint32Array.of(0x1 | 0x2 | 0x10000 | 0x20000 | 0x40000).buffer),
			new Uint8Array(Uint16Array.of(0x3, 2, 24).buffer),
			Uint8Array.of(0, 0, 0, 3)
		)

		expect(readCF(cf, 0, cf.length).cf).toEqual({ bold: true, italic: true, font: 2, size: 24, color: { scheme: 3 } })
	})

	it("refuses a property that runs past its record, typed", () => {
		const pf = new Uint8Array(Uint32Array.of(0x100000).buffer)

		expect(() => readPF(pf, 0, pf.length)).toThrow(expect.objectContaining({ reason: "malformed" }))
	})

	it("splits paragraphs at carriage returns, lines at vertical tabs, runs where formatting or fields change", () => {
		const block: TextBlock = {
			type: 1,
			text: "Ab\vc*\rNext",
			pfRuns: [
				{ count: 6, level: 0, pf: {} },
				{ count: 5, level: 1, pf: { align: 2 } }
			],
			cfRuns: [
				{ count: 1, cf: { bold: true } },
				{ count: 10, cf: {} }
			],
			fields: [{ position: 4, kind: "slidenum" }],
			links: []
		}
		const paragraphs = paragraphsOf(block)

		expect(paragraphs.map(paragraph => paragraph.level)).toEqual([0, 1])
		expect(paragraphs[0]?.runs.map(run => [run.text, run.lineBreak ?? false, run.field?.kind])).toEqual([
			["A", false, undefined],
			["b", false, undefined],
			["", true, undefined],
			["c", false, undefined],
			["*", false, "slidenum"]
		])
		expect(paragraphs[1]?.pf).toEqual({ align: 2 })
	})

	it("keeps the text of a body whose formatting is damaged, and says so", async () => {
		const deck = await pptToPptx(
			bytesSource(
				(
					await buildPpt({
						slides: [
							{
								shapes: [
									{
										text: "Damaged",
										anchor: [0, 0, 100, 100],
										rawStyle: concat(
											new Uint8Array(Uint32Array.of(8).buffer),
											Uint8Array.of(0, 0),
											new Uint8Array(Uint32Array.of(0x100000).buffer)
										)
									}
								]
							}
						]
					})
				).bytes
			)
		)

		if (deck.kind === "refused") throw new Error(deck.reason)

		expect(deck.losses).toContainEqual({ kind: "damagedContent", count: 1, slides: [1] })

		const opened = await openPptxPackage(deck.pptx)

		if (opened.kind === "refused") throw new Error(opened.reason)

		await opened.parts.parseAll()
		expect(slideShapes(opened.deck, 0).map(textOf)).toEqual(["Damaged"])
	})
})

describe("ppt pictures and encryption", () => {
	const PICTURE: FixtureOptions = { slides: [{ shapes: [{ picture: true, anchor: [100, 100, 1000, 1000] }] }], png: FIXTURE_PNG }

	it("reads a picture from the Pictures stream when its part is read", async () => {
		const converted = await pptToPptx(bytesSource((await buildPpt(PICTURE)).bytes))

		if (converted.kind === "refused") throw new Error(converted.reason)

		const media = [...converted.pptx.entries()].filter(entry => entry.name.startsWith("ppt/media/"))

		expect(media.map(entry => entry.name)).toEqual(["ppt/media/image1.png"])
		expect(await converted.pptx.read("ppt/media/image1.png")).toEqual(FIXTURE_PNG)
	})

	it("decrypts every persist object and the Pictures stream with the right password", async () => {
		for (const keySize of [40, 56, 128]) {
			const built = await buildPpt({
				...TWO_SLIDES,
				slides: [...TWO_SLIDES.slides, ...PICTURE.slides],
				png: FIXTURE_PNG,
				password: "secret",
				keySize
			})
			const file = await openPptFile(bytesSource(built.bytes), { decryption: decryption("secret") })

			expect(file.encrypted).toBe(true)

			for (const [id, offset] of built.persist) {
				if (id === file.directory.current.encryptSessionPersistIdRef) continue

				const end = recordAt(built.plainStream, offset).end

				expect(file.stream.subarray(offset, end), `persist ${String(id)}`).toEqual(built.plainStream.subarray(offset, end))
			}

			const converted = await pptToPptx(bytesSource(built.bytes), { decryption: decryption("secret") })

			if (converted.kind === "refused") throw new Error(converted.reason)

			expect(await converted.pptx.read("ppt/media/image1.png")).toEqual(FIXTURE_PNG)
		}
	})

	it("asks for a password, refuses a wrong one, and opens with the right one", async () => {
		const built = await buildPpt({ ...TWO_SLIDES, password: "secret" })

		expect(await pptToPptx(bytesSource(built.bytes))).toMatchObject({ kind: "refused", reason: "needsPassword" })
		expect(await pptToPptx(bytesSource(built.bytes), { decryption: decryption("Secret") })).toMatchObject({
			kind: "refused",
			reason: "wrongPassword"
		})

		const deck = await deckOf({ ...TWO_SLIDES, password: "secret" }, "secret")

		expect(slideShapes(deck, 0).map(textOf)).toEqual(["Hello", "Box"])
	})

	it("refuses a damaged encryption header as damaged", async () => {
		const built = await buildPpt({ ...TWO_SLIDES, password: "secret" })
		const file = await openPptFile(bytesSource(built.bytes), { decryption: decryption("secret") }).catch((error: unknown) => error)

		expect(file).not.toBeInstanceOf(Error)

		// Cut the session's EncryptionHeader short: its record length shrinks to 20 bytes.
		const session = built.persist.get(Math.max(...built.persist.keys())) ?? 0
		const { CfbFile, cfbBytes } = await import("../core/cfb/index")
		const cfb = await CfbFile.open(bytesSource(built.bytes))
		const stream = (await cfb.read("PowerPoint Document")).slice()

		stream.set(new Uint8Array(Uint32Array.of(20).buffer), session + 4)

		const damaged = await cfbBytes([
			{ path: ["Current User"], bytes: await cfb.read("Current User") },
			{ path: ["PowerPoint Document"], bytes: stream }
		])

		expect(await pptToPptx(bytesSource(damaged), { decryption: decryption("secret") })).toMatchObject({
			kind: "refused",
			reason: "damagedEncryption"
		})
	})
})
