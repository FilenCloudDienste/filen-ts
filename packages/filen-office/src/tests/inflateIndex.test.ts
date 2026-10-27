import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { deflateSync, inflateSync } from "fflate"
import { describe, expect, it } from "vitest"
import { bytesSource, crc32, ZipArchive, ZipError } from "@filen/office/core/opc"
import { InflateIndex, type InflateInput } from "../core/opc/inflateIndex"
import { CORPUS_DIR } from "./corpusDir"
import { isPresentation } from "./oracles/presentation/corpus"
import { budget } from "./timing"

// Random access into deflate streams: every byte equals fflate's inflate, from any offset, with the work of a read
// bounded by the checkpoint spacing.

function input(compressed: Uint8Array, reads?: { count: number }): InflateInput {
	return {
		size: compressed.length,
		read(offset, length) {
			if (reads !== undefined) reads.count++

			return Promise.resolve(compressed.slice(offset, offset + length))
		}
	}
}

// Bytes mixing noise, runs and repeats of earlier stretches, so a deflater uses literals, short and long matches
// and far distances.
function mixed(size: number, seed: number): Uint8Array {
	const out = new Uint8Array(size)
	let state = seed >>> 0 || 1
	const next = (): number => {
		state ^= state << 13
		state ^= state >>> 17
		state ^= state << 5

		return state >>> 0
	}

	for (let at = 0; at < size;) {
		const kind = next() % 4
		const length = Math.min(size - at, 1 + (next() % 3000))

		if (kind === 0 || at < 64) for (let k = 0; k < length; k++) out[at + k] = next() & 0xff
		else if (kind === 1) out.fill(next() & 0xff, at, at + length)
		else {
			const distance = 1 + (next() % Math.min(at, 32_768))

			for (let k = 0; k < length; k++) out[at + k] = out[at + k - distance] ?? 0
		}

		at += length
	}

	return out
}

async function index(raw: Uint8Array, compressed: Uint8Array, every?: number): Promise<InflateIndex> {
	return InflateIndex.build(input(compressed), { size: raw.length, crc32: crc32(raw), ...(every === undefined ? {} : { every }) })
}

describe("inflateIndex", () => {
	it("reads every byte equal to the input at every deflate level", async () => {
		const raw = mixed(1_500_000, 7)

		for (const level of [0, 1, 4, 6, 9] as const) {
			const compressed = deflateSync(raw, { level })
			const built = await index(raw, compressed, 64 * 1024)

			expect(built.checkpoints.length).toBeGreaterThan(20)
			same(await built.read(0, raw.length), raw)

			for (const [offset, length] of [
				[0, 1],
				[65_535, 3],
				[65_536, 70_000],
				[777_777, 123_456],
				[raw.length - 5, 5]
			] as const) {
				same(await built.read(offset, length), raw.subarray(offset, offset + length), `level ${String(level)} at ${String(offset)}`)
			}
		}
	})

	it("decodes fixed-code and stored blocks, and empty and one-byte streams", async () => {
		// fflate writes short inputs with the fixed code.
		for (const raw of [new Uint8Array(0), Uint8Array.of(65), new TextEncoder().encode("abcabcabcabcabc hello hello hello")]) {
			const built = await index(raw, deflateSync(raw))

			same(await built.read(0, raw.length), raw)
		}

		// Stored blocks, hand-made: two blocks, the first not final.
		const first = Uint8Array.from({ length: 300 }, (_, k) => k & 0xff)
		const second = Uint8Array.from({ length: 40 }, (_, k) => 255 - k)
		const stored = Uint8Array.of(
			0,
			300 & 0xff,
			300 >> 8,
			~300 & 0xff,
			(~300 >> 8) & 0xff,
			...first,
			1,
			40,
			0,
			~40 & 0xff,
			0xff,
			...second
		)
		const raw = Uint8Array.of(...first, ...second)
		const built = await index(raw, stored, 100)

		same(await built.read(250, 80), raw.subarray(250, 330))
	})

	it("bounds a read's work by the checkpoint spacing, and continues a read just past the last", async () => {
		const raw = mixed(6_000_000, 11)
		const compressed = deflateSync(raw, { level: 6 })
		const every = 512 * 1024
		const built = await index(raw, compressed, every)
		const stats = { work: 0 }

		same(await built.read(5_000_000, 1000, stats), raw.subarray(5_000_000, 5_001_000))
		expect(stats.work).toBeLessThanOrEqual(every + 1000 + 258)

		// Sequential reads continue the live decoder: each costs about its own length.
		same(await built.read(5_001_000, 4000, stats), raw.subarray(5_001_000, 5_005_000))
		expect(stats.work).toBeLessThanOrEqual(4000 + 258)
		expect(built.windowBytes).toBeLessThanOrEqual(built.checkpoints.length * (32_768 + 320))
	})

	it("serves reads side by side", async () => {
		const raw = mixed(3_000_000, 3)
		const built = await index(raw, deflateSync(raw), 256 * 1024)
		const offsets = [2_900_000, 10, 1_234_567, 2_000_000, 700_000]
		const reads = await Promise.all(offsets.map(offset => built.read(offset, 50_000)))

		reads.forEach((bytes, k) => same(bytes, raw.subarray(offsets[k], (offsets[k] ?? 0) + 50_000)))
	})

	it("refuses a damaged stream, a wrong CRC, a wrong size and a truncated stream", async () => {
		const raw = mixed(400_000, 5)
		const compressed = deflateSync(raw)

		await expect(InflateIndex.build(input(compressed), { size: raw.length, crc32: crc32(raw) ^ 1 })).rejects.toBeInstanceOf(ZipError)
		await expect(InflateIndex.build(input(compressed), { size: raw.length + 1, crc32: crc32(raw) })).rejects.toBeInstanceOf(ZipError)
		await expect(InflateIndex.build(input(compressed), { size: raw.length - 1, crc32: crc32(raw) })).rejects.toBeInstanceOf(ZipError)
		await expect(
			InflateIndex.build(input(compressed.subarray(0, compressed.length >> 1)), { size: raw.length, crc32: crc32(raw) })
		).rejects.toBeInstanceOf(ZipError)

		const damaged = compressed.slice()

		damaged[0] = (damaged[0] ?? 0) | 0x06
		await expect(InflateIndex.build(input(damaged), { size: raw.length, crc32: crc32(raw) })).rejects.toBeInstanceOf(ZipError)
	})

	it("yields to the host while it builds and stops when aborted", async () => {
		const raw = mixed(2_000_000, 9)
		const compressed = deflateSync(raw)
		let pauses = 0
		let now = 0
		const slicing = {
			sliceMs: 1,
			now: () => (now += 1),
			pause: () => {
				pauses++

				return Promise.resolve()
			}
		}

		await InflateIndex.build(input(compressed), { size: raw.length, crc32: crc32(raw), slicing })
		expect(pauses).toBeGreaterThan(2)

		const signal = { aborted: false }
		const build = InflateIndex.build(input(compressed), {
			size: raw.length,
			crc32: crc32(raw),
			signal,
			progress: () => {
				signal.aborted = true
			}
		})

		await expect(build).rejects.toBeInstanceOf(ZipError)
	})
})

// Every deflated entry of every presentation in the corpus inflates, through the index, to fflate's bytes.
const PRESENTATIONS = (() => {
	const out: string[] = []

	if (!existsSync(CORPUS_DIR)) return out

	for (const directory of readdirSync(CORPUS_DIR, { withFileTypes: true })) {
		if (!directory.isDirectory()) continue

		for (const file of readdirSync(join(CORPUS_DIR, directory.name))) {
			if (isPresentation(file) && !/\.(ppt|pps|pot)$/iu.test(file)) out.push(join(CORPUS_DIR, directory.name, file))
		}
	}

	return out
})()

describe.skipIf(PRESENTATIONS.length === 0)("inflateIndex over the corpus", () => {
	it("equals fflate on every deflated entry of every presentation", { timeout: budget(600_000) }, async () => {
		let entries = 0
		let bytes = 0
		const failures: string[] = []

		for (const path of PRESENTATIONS) {
			const file = new Uint8Array(readFileSync(path))
			let archive: ZipArchive

			try {
				archive = await ZipArchive.open(bytesSource(file), {
					limits: { maxEntries: 20_000, maxEntryUncompressed: 2 ** 32, maxTotalUncompressed: 2 ** 53 }
				})
			} catch {
				// Encrypted and damaged packages are not zips we read.
				continue
			}

			for (const entry of archive.entries) {
				if (entry.method !== 8) continue

				const compressed = await archive.raw(entry)
				let expected: Uint8Array

				try {
					expected = inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) })
				} catch {
					continue
				}

				if (crc32(expected) !== entry.crc32) continue

				const built = await InflateIndex.build(input(compressed), {
					size: entry.uncompressedSize,
					crc32: entry.crc32,
					every: 256 * 1024
				})
				const actual = await built.read(0, entry.uncompressedSize)
				const middle = entry.uncompressedSize >> 1
				const tail = await built.read(middle, entry.uncompressedSize - middle)

				if (!equal(actual, expected) || !equal(tail, expected.subarray(middle))) failures.push(`${path}: ${entry.name}`)

				entries++
				bytes += entry.uncompressedSize
			}
		}

		expect(failures).toEqual([])
		expect(entries).toBeGreaterThan(1000)
		expect(bytes).toBeGreaterThan(10_000_000)
	})
})

// Byte arrays compared without the matcher's per-element diff (megabytes of it are slow).
function same(actual: Uint8Array, expected: Uint8Array, message?: string): void {
	expect(equal(actual, expected), message).toBe(true)
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}
