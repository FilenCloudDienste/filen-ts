import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ZipArchive, bytesSource, memorySink } from "../../../core/opc/index"
import { decodePng } from "../../oracles/presentation/pixel"
import { BIG_DECKS, bigDeck, mp4Chunks, writeBigDeck, type BigDeckSpec } from "./bigDeck"

// The large decks the streaming, memory and save budgets open, checked on a scaled-down spec (same code path) and
// on the 50 MB deck itself.

const SMALL: BigDeckSpec = {
	media: [
		{ kind: "png", bytes: 40_000, deflate: false },
		{ kind: "png", bytes: 40_000, deflate: true },
		{ kind: "mp4", bytes: 300_000, deflate: false, faststart: true },
		{ kind: "mp4", bytes: 300_000, deflate: true, faststart: false }
	],
	extraSlides: 2,
	seed: 9
}

async function written(spec: BigDeckSpec): Promise<Uint8Array> {
	const sink = memorySink()

	await writeBigDeck(spec, sink)

	return sink.bytes().slice()
}

const decoder = new TextDecoder()

// Top-level ISO BMFF boxes: type and offset.
function boxes(bytes: Uint8Array): { type: string; at: number; size: number }[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const out: { type: string; at: number; size: number }[] = []

	for (let at = 0; at + 8 <= bytes.length;) {
		const size = view.getUint32(at)

		out.push({ type: decoder.decode(bytes.subarray(at + 4, at + 8)), at, size })
		at += size
	}

	return out
}

async function joined(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const parts: Uint8Array[] = []

	for await (const chunk of chunks) parts.push(chunk.slice())

	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

describe("generated big decks", () => {
	const dir = mkdtempSync(join(tmpdir(), "big-deck-test-"))

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	it("makes the same bytes for the same spec, and other bytes for another seed", async () => {
		const a = await written(SMALL)

		expect(await written(SMALL)).toEqual(a)
		expect(await written({ ...SMALL, seed: 10 })).not.toEqual(a)
	})

	it("stores and deflates each medium as its spec says, with every relationship target present", async () => {
		const archive = await ZipArchive.open(bytesSource(await written(SMALL)))
		const byName = new Map(archive.entries.map(entry => [entry.name, entry]))

		expect(byName.get("ppt/media/image1.png")?.method).toBe(0)
		expect(byName.get("ppt/media/image2.png")?.method).toBe(8)
		expect(byName.get("ppt/media/media3.mp4")?.method).toBe(0)
		expect(byName.get("ppt/media/media4.mp4")?.method).toBe(8)
		expect(byName.get("ppt/media/media4.mp4")?.compressedSize).toBeLessThan(0.6 * 300_000)

		const entry = (name: string) => {
			const found = byName.get(name)

			if (found === undefined) throw new Error(`${name} missing`)

			return found
		}
		const presentation = decoder.decode(await archive.read(entry("ppt/presentation.xml")))

		expect([...presentation.matchAll(/<p:sldId /g)]).toHaveLength(6)

		for (const rels of archive.entries.filter(item => item.name.endsWith(".rels"))) {
			const base = rels.name.replace(/_rels\/[^/]*\.rels$/, "")

			for (const match of decoder.decode(await archive.read(rels)).matchAll(/Target="([^"]*)"/g)) {
				const parts = `${base}${match[1] ?? ""}`.split("/")
				const resolved: string[] = []

				for (const part of parts) {
					if (part === "..") resolved.pop()
					else if (part !== "" && part !== ".") resolved.push(part)
				}

				expect(byName.has(resolved.join("/")), `${rels.name} -> ${match[1] ?? ""}`).toBe(true)
			}
		}

		const png = decodePng(await archive.read(entry("ppt/media/image1.png")))

		expect(png.width).toBe(1024)
		expect(png.data.length).toBe(png.width * png.height * 4)
	})

	it("puts moov after mdat in a non-fast-start MP4, before it in a fast-start one, its chunk offset at the payload", async () => {
		const late = await joined(mp4Chunks(500_000, 1, false, true).chunks())
		const early = await joined(mp4Chunks(500_000, 1, true, false).chunks())

		expect(late.length).toBe(500_000)
		expect(early.length).toBe(500_000)
		expect(boxes(late).map(item => item.type)).toEqual(["ftyp", "mdat", "moov"])
		expect(boxes(early).map(item => item.type)).toEqual(["ftyp", "moov", "mdat"])

		for (const file of [late, early]) {
			const mdat = boxes(file).find(item => item.type === "mdat")
			const moov = boxes(file).find(item => item.type === "moov")

			if (mdat === undefined || moov === undefined) throw new Error("mdat or moov missing")

			const stco = decoder.decode(file.subarray(moov.at, moov.at + moov.size)).indexOf("stco")
			// stco: size, type, version and flags, entry count, then the first chunk offset.
			const offset = new DataView(file.buffer, file.byteOffset).getUint32(moov.at + stco + 12)

			expect(offset).toBe(mdat.at + 8)
		}
	})

	it("sizes the decks the budgets name: a 200 MB deflated late-moov MP4, 2 GB of stored media", () => {
		const video = BIG_DECKS.video200.media[0]

		expect(video).toEqual({ kind: "mp4", bytes: 200 * 1024 * 1024, deflate: true, faststart: false })

		const stored = BIG_DECKS.memory2g.media.filter(item => !item.deflate).reduce((sum, item) => sum + item.bytes, 0)

		expect(stored).toBeGreaterThan(2_000_000_000)
		expect(stored).toBeLessThan(2 ** 32)
	})

	it("writes the streaming deck over 50 MB once into the temporary directory and reuses it", { timeout: 60_000 }, async () => {
		const path = await bigDeck("streaming", dir)
		const made = statSync(path)

		expect(made.size).toBeGreaterThan(50 * 1024 * 1024)
		expect(await bigDeck("streaming", dir)).toBe(path)
		expect(statSync(path).mtimeMs).toBe(made.mtimeMs)

		const archive = await ZipArchive.open(bytesSource(new Uint8Array(readFileSync(path))))
		const media = archive.entries.filter(entry => entry.name.startsWith("ppt/media/"))

		expect(media.some(entry => entry.method === 0 && entry.name.endsWith(".png"))).toBe(true)
		expect(media.some(entry => entry.method === 8 && entry.name.endsWith(".png"))).toBe(true)
		expect(media.some(entry => entry.method === 8 && entry.name.endsWith(".mp4"))).toBe(true)
	})
})
