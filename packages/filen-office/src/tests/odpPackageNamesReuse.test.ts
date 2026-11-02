import { describe, expect, it } from "vitest"
import { insertChartOp, sampleChartCells } from "../core/presentation/edit/commands/chart"
import type { DeckOp, FileLike } from "../core/presentation/edit/ops"
import { noteIssuedNames } from "../core/presentation/issuedNames"
import type { Background, ShapeNode, SlideRef, Xfrm } from "../core/presentation/model"
import { mediaCapability } from "../dom/presentation/engine/media"
import { driveSession } from "./odpWriteDrive"
import { entriesOf } from "./odpWriteFixtures"
import { designOdp } from "./presentationDesignFixtures"
import { image } from "./presentationObjectsFixtures"

// Names of the entries ODP saves add (background tiles, media and posters, inserted pictures, chart objects): a name a
// save left out may still be named by a registry or a step; an entry a later save adds never takes it, nor a name the
// package already has. Undoing back past every save writes the source's package again, entry for entry.

type Drive = Awaited<ReturnType<typeof driveSession>>

const BOX: Xfrm = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }

function pattern(preset: string, rgb: string): Background {
	return { kind: "fill", fill: { kind: "pattern", preset, fg: { kind: "srgb", rgb }, bg: { kind: "srgb", rgb: "FFFFFF" } } }
}

// An MP4 header ("ftyp isom") then bytes of `seed`.
function mp4(size: number, seed: number): Uint8Array {
	const bytes = new Uint8Array(size)
	let state = seed

	for (let k = 0; k < size; k++) {
		state = (state * 1_103_515_245 + 12_345) >>> 0
		bytes[k] = state >>> 24
	}

	bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31], 0)

	return bytes
}

function clip(bytes: Uint8Array): FileLike {
	return {
		size: bytes.length,
		name: "clip.mp4",
		type: "video/mp4",
		slice: (start = 0, end = bytes.length) => ({ arrayBuffer: () => Promise.resolve(bytes.slice(start, end).buffer) })
	}
}

function pictures(entries: ReadonlyMap<string, Uint8Array>): string[] {
	return [...entries.keys()].filter(name => name.startsWith("Pictures/"))
}

// The entries a save adds for a medium: its bytes and its poster.
function authored(entries: ReadonlyMap<string, Uint8Array>): string[] {
	return [...entries.keys()].filter(name => /^(?:Pictures|Media)\//u.test(name))
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

async function samePackage(source: Uint8Array, out: Uint8Array): Promise<void> {
	const a = await entriesOf(source)
	const b = await entriesOf(out)

	expect([...b.keys()].sort()).toEqual([...a.keys()].sort())

	for (const [name, bytes] of a) expect(Buffer.from(b.get(name) ?? []).equals(Buffer.from(bytes)), name).toBe(true)
}

function background(d: Drive, value: Background, which: "all" | number): DeckOp {
	const slide = typeof which === "number" ? d.session.deck.slides[which] : undefined

	return { family: "design", kind: "setBackground", slides: slide === undefined ? "all" : [slide], background: value }
}

describe("an ODP background tile whose save was undone", () => {
	it("writes the source's package after a different tile saved and every step undone", async () => {
		const source = await designOdp(2)
		const d = await driveSession(source)

		await run(d, background(d, pattern("dkUpDiag", "000080"), "all"))
		await written(d)
		await d.undo()
		await run(d, background(d, pattern("smGrid", "800000"), "all"))
		await written(d)
		await d.undo()
		await samePackage(source, await written(d))
	})

	it("never gives a later tile the name of one a save left out", async () => {
		const source = await designOdp(2)
		const d = await driveSession(source)

		await run(d, background(d, pattern("dkUpDiag", "000080"), "all"))

		const first = pictures(await entriesOf(await written(d)))

		expect(first).toHaveLength(1)

		await d.undo()
		// Nothing names the tile any more: the save after the undo leaves it out.
		expect(pictures(await entriesOf(await written(d)))).toEqual([])

		await run(d, background(d, pattern("smGrid", "800000"), "all"))

		const later = pictures(await entriesOf(await written(d)))

		expect(later).toHaveLength(1)
		expect(later).not.toContain(first[0])

		await d.undo()
		await samePackage(source, await written(d))
	})
})

describe("an inserted medium whose save was undone", () => {
	it("never gives a later medium or poster the names a save left out", async () => {
		const d = await driveSession(await designOdp(1))
		const slide = d.session.deck.slides[0] as SlideRef
		const insert = async (seed: number): Promise<void> => {
			const registered = await mediaCapability.registerMedia(d.context, { kind: "file", file: clip(mp4(4096, seed)) })

			if ("reason" in registered) throw new Error(registered.reason)

			const shape = { id: 0, name: "clip.mp4", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

			await run(d, {
				family: "media",
				kind: "insert",
				slide,
				shape,
				media: { ...registered, poster: image(16, 9), durationMs: 1000 }
			})
		}

		await insert(7)

		const first = authored(await entriesOf(await written(d)))

		expect(first).toHaveLength(2)

		await d.undo()
		// The redo needs the medium the save wrote (the registry let go of the file); an edit lets go of the redo.
		await run(d, background(d, { kind: "fill", fill: { kind: "solid", color: { kind: "srgb", rgb: "336699" } } }, 0))
		expect(authored(await entriesOf(await written(d)))).toEqual([])

		await insert(11)

		const later = authored(await entriesOf(await written(d)))

		expect(later).toHaveLength(2)
		for (const name of first) expect(later).not.toContain(name)
	})
})

describe("an image inserted again in a later session of the file", () => {
	it("is written beside the earlier session's entry of the same image, not refused", async () => {
		let bytes = await designOdp(1)
		const names: string[][] = []

		for (let session = 0; session < 2; session++) {
			const d = await driveSession(bytes)
			const slide = d.session.deck.slides[0] as SlideRef
			const shape = { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: BOX } as ShapeNode

			await run(d, { family: "picture", kind: "insert", slide, shape, image: image(64, 32) })
			bytes = await written(d)
			names.push(pictures(await entriesOf(bytes)))
		}

		expect(names[0]).toHaveLength(1)
		expect(names[1]).toHaveLength(2)
		expect(names[1]).toContain(names[0]?.[0])
	})
})

describe("a chart inserted into an ODP deck", () => {
	it("takes no object name a package of the session had", async () => {
		const d = await driveSession(await designOdp(1))
		const slide = d.session.deck.slides[0] as SlideRef

		// A package of the session had "Object 1" (a version the file was rebased onto since dropped it).
		noteIssuedNames(d.session.deck, ["Object 1/content.xml", "Object 1/"])
		await run(d, insertChartOp(d.session.deck, slide, 0, "column", sampleChartCells({ categories: ["A", "B"], series: ["North"] })))

		const objects = [...(await entriesOf(await written(d))).keys()].filter(name => name.startsWith("Object "))

		expect(objects.length).toBeGreaterThan(0)
		expect(objects.every(name => name.startsWith("Object 2/"))).toBe(true)
	})
})
