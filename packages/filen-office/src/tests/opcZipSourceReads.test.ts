import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { bytesSource, chunksSource, crc32, memorySink, planZip, writeZip, ZipArchive, ZipError, type ByteSource } from "../core/opc/index"
import { savePptx } from "../core/pptx/write/save"
import { body, buildPptx, para, sp } from "./pptxFixtures"
import { Changes, openDeck, shapeOf, slideNode } from "./pptxWriteFixtures"

// What the zip layer does with the reads of its source: a copy that comes back short fails the package instead of
// shifting every later byte, and a read that fails reaches the caller as it failed, never as damaged deflate data.

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "T", 'type="title"', "", body(para("One"))) +
					sp(5, "Box", undefined, '<a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>')
			},
			{ shapes: sp(2, "T", 'type="title"', "", body(para("Two ".repeat(200)))) }
		]
	})
}

// The bytes of `bytes`, except that a read starting at `short` comes back 7 bytes short (the SDK's range read returns
// what it received).
function shortAt(bytes: Uint8Array, short: number, checked: boolean): ByteSource {
	const slice = (offset: number, length: number): Uint8Array => bytes.slice(offset, offset + (offset === short ? length - 7 : length))

	return checked
		? {
				size: bytes.length,
				read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
				readChecked: (offset, length, crc) => {
					const read = slice(offset, length)

					return Promise.resolve({ bytes: read, crc: crc32(read, crc) })
				}
			}
		: { size: bytes.length, read: (offset, length) => Promise.resolve(slice(offset, length)) }
}

// How many bytes short a copy of slide 2 read, from the writer's error.
function shortBy(message: string): number | undefined {
	const match = /^A copy of ppt\/slides\/slide2\.xml read (\d+) of (\d+) bytes$/u.exec(message)

	return match === null ? undefined : Number(match[2]) - Number(match[1])
}

describe("zip copies read short", () => {
	for (const checked of [true, false]) {
		it(`fails the package when a ${checked ? "checked" : "plain"} copy read comes back short`, async () => {
			const bytes = deck()
			const victim = (await ZipArchive.open(bytesSource(bytes))).get("ppt/slides/slide2.xml")!
			const archive = await ZipArchive.open(shortAt(bytes, victim.localHeaderOffset, checked))

			const error = await writeZip(planZip(archive, {}), archive, memorySink()).then(
				() => undefined,
				(failure: unknown) => failure
			)

			expect(error).toBeInstanceOf(ZipError)
			expect(shortBy((error as ZipError).message)).toBe(7)
		})
	}

	for (const path of ["in memory", "streamed"] as const) {
		it(`never writes a pptx save whose copy was served short (${path})`, async () => {
			const bytes = deck()
			const opened = await openDeck(bytes)
			const victim = (await ZipArchive.open(bytesSource(bytes))).get("ppt/slides/slide2.xml")!
			const node = slideNode(opened, 0)

			shapeOf(node, 5).xfrm = { x: 9, y: 9, cx: 9, cy: 9, rot: 0, flipH: false, flipV: false }

			const source = { ...opened.source, archive: await ZipArchive.open(shortAt(bytes, victim.localHeaderOffset, true)) }
			const sink = memorySink()
			let closed = false
			const outcome = await savePptx(
				{ deck: opened.deck, source, changes: new Changes().shape(node.part, 5, { kind: "xfrm" }).build(), revision: 1 },
				{
					write: chunk => sink.write(chunk),
					close: () => {
						closed = true

						return Promise.resolve()
					}
				},
				path === "streamed" ? { inMemoryLimit: 16 } : {}
			).then(
				result => result.kind,
				(error: unknown) => (error instanceof ZipError ? error.message : "other")
			)

			expect(shortBy(outcome)).toBe(7)
			expect(closed).toBe(false)
		})
	}
})

describe("zip entries whose source read fails", () => {
	it("rejects a deflated entry's read with the source's own error", async () => {
		const bytes = deck()
		const archive = await ZipArchive.open(bytesSource(bytes))
		const entry = archive.get("ppt/slides/slide2.xml")!

		expect(entry.method).toBe(8)

		const failure = new Error("the deck was rebased onto its saved file")
		const failing: ByteSource = {
			size: bytes.length,
			// Every read inside the entry's data fails; its local header and the central directory read.
			read: (offset, length) =>
				offset > entry.localHeaderOffset && offset < entry.localHeaderOffset + 64 + entry.nameBytes.length + entry.compressedSize
					? Promise.reject(failure)
					: Promise.resolve(bytes.subarray(offset, offset + length))
		}
		const reopened = await ZipArchive.open(failing)
		const target = reopened.get("ppt/slides/slide2.xml")!

		await expect(reopened.read(target)).rejects.toBe(failure)

		const streamed = (async () => {
			for await (const chunk of reopened.stream(target)) void chunk
		})()

		await expect(streamed).rejects.toBe(failure)
	})
})

describe("in-memory pptx save", () => {
	it("hands the package to the sink as the pieces it was written in, never one joined copy", async () => {
		// Slide 2 deflates to well over the writer's 64 KiB batches, so the package is written in several pieces.
		const noise = randomBytes(150_000).toString("base64")
		const bytes = buildPptx({
			slides: [
				{
					shapes:
						sp(2, "T", 'type="title"', "", body(para("One"))) +
						sp(5, "Box", undefined, '<a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm>')
				},
				{ shapes: sp(2, "T", 'type="title"', "", body(para(noise))) }
			]
		})
		const opened = await openDeck(bytes)
		const node = slideNode(opened, 0)

		shapeOf(node, 5).xfrm = { x: 9, y: 9, cx: 9, cy: 9, rot: 0, flipH: false, flipV: false }

		// Every read a fresh buffer, as a range source's are.
		const remote: ByteSource = { size: bytes.length, read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)) }
		const source = { ...opened.source, archive: await ZipArchive.open(remote) }
		const chunks: Uint8Array[] = []
		const outcome = await savePptx(
			{ deck: opened.deck, source, changes: new Changes().shape(node.part, 5, { kind: "xfrm" }).build(), revision: 1 },
			{ write: chunk => Promise.resolve(void chunks.push(chunk)), close: () => Promise.resolve() },
			{}
		)

		if (outcome.kind !== "written") throw new Error(outcome.kind)

		expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(outcome.report.size)
		expect(Math.max(...chunks.map(chunk => chunk.buffer.byteLength))).toBeLessThan(outcome.report.size)

		const back = await ZipArchive.open(chunksSource(chunks))

		expect(new TextDecoder().decode(await back.read(back.get("ppt/slides/slide1.xml")!))).toContain('<a:off x="9" y="9"/>')
	})

	it("reads chunks laid end to end as one source: views inside a chunk, copies across", async () => {
		const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array(0), new Uint8Array([4, 5]), new Uint8Array([6])]
		const source = chunksSource(chunks)

		expect(source.size).toBe(6)
		expect(await source.read(0, 6)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
		expect((await source.read(3, 2)).buffer).toBe(chunks[2]!.buffer)
		expect(await source.read(2, 3)).toEqual(new Uint8Array([3, 4, 5]))
		await expect(source.read(5, 2)).rejects.toThrow("Read outside the source")
	})
})
