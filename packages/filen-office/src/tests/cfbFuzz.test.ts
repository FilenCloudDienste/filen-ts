import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CfbError, CfbFile, cfbBytes, isCompoundFile, type CfbWriteEntry } from "@filen/office/core/cfb"
import { bytesSource } from "@filen/office/core/opc"
import { CORPUS_DIR } from "./corpusDir"
import { budget } from "./timing"

// Mutated compound files (sector chains, sizes, directory links, header counts, truncation): the reader
// answers each with a result or a CfbError, never another throw, and within a time bound.

const MUTANTS = Number(process.env["FILEN_OFFICE_CFB_FUZZ"] || "3000")
const SEED = Number(process.env["FILEN_OFFICE_CFB_FUZZ_SEED"] || "346")
// Per file: open, walk, read every stream and some ranges. Generous for a loaded machine; typical is < 1 ms.
const BOUND_MS = 500

class Random {
	private state: number

	constructor(seed: number) {
		this.state = seed || 1
	}

	next(): number {
		this.state ^= this.state << 13
		this.state ^= this.state >>> 17
		this.state ^= this.state << 5

		return this.state >>> 0
	}

	below(limit: number): number {
		return limit <= 0 ? 0 : this.next() % limit
	}

	pick<T>(items: readonly T[]): T {
		return items[this.below(items.length)] as T
	}
}

function noise(length: number, random: Random): Uint8Array {
	const out = new Uint8Array(length)

	for (let k = 0; k < length; k++) out[k] = random.next() & 0xff

	return out
}

async function seeds(): Promise<Uint8Array[]> {
	const random = new Random(7)
	const encrypted: CfbWriteEntry[] = [
		{ path: ["EncryptionInfo"], bytes: noise(900, random) },
		{ path: ["EncryptedPackage"], bytes: noise(30_000, random) },
		{ path: ["\u0006DataSpaces", "Version"], bytes: noise(76, random) },
		{ path: ["\u0006DataSpaces", "DataSpaceMap"], bytes: noise(112, random) },
		{ path: ["\u0006DataSpaces", "DataSpaceInfo", "StrongEncryptionDataSpace"], bytes: noise(64, random) },
		{ path: ["\u0006DataSpaces", "TransformInfo", "StrongEncryptionTransform", "\u0006Primary"], bytes: noise(200, random) }
	]
	const many: CfbWriteEntry[] = Array.from({ length: 60 }, (_, k) => ({
		path: k % 3 === 0 ? [`S${k % 7}`, `N${k}`] : [`N${k}`],
		bytes: noise(random.below(9_000), random)
	}))
	const out = [
		await cfbBytes(encrypted),
		await cfbBytes(encrypted, { version: 4 }),
		await cfbBytes(many),
		await cfbBytes(many, { version: 4 })
	]

	// Every compound file of the corpus under 1 MB (legacy binaries, encrypted packages, POI's damaged samples).
	if (existsSync(CORPUS_DIR)) {
		for (const family of readdirSync(CORPUS_DIR, { withFileTypes: true })) {
			if (!family.isDirectory()) continue

			for (const name of readdirSync(join(CORPUS_DIR, family.name))) {
				const path = join(CORPUS_DIR, family.name, name)

				if (statSync(path).size > 1_000_000) continue

				const bytes = new Uint8Array(readFileSync(path))

				if (isCompoundFile(bytes)) out.push(bytes)
			}
		}
	}

	return out
}

const INTERESTING = [
	0, 1, 2, 3, 0x7f, 0x80, 0xff, 0x1000, 0xffff, 0x7fffffff, 0x80000000, 0xfffffffa, 0xfffffffc, 0xfffffffd, 0xfffffffe, 0xffffffff
]

function mutate(seed: Uint8Array, random: Random): Uint8Array {
	let bytes = seed.slice()
	const data = (): DataView => new DataView(bytes.buffer)
	const sectorSize = data().getUint16(0x1e, true) === 12 ? 4096 : 512
	const sectors = Math.max(1, Math.floor(bytes.length / sectorSize) - 1)
	const value = (): number => {
		switch (random.below(4)) {
			case 0:
				return random.pick(INTERESTING)
			case 1:
				return random.below(sectors + 2)
			case 2:
				return random.below(64)
			default:
				return random.next()
		}
	}
	const get = (at: number): number => (at + 4 <= bytes.length ? data().getUint32(at, true) : 0xffffffff)
	const put = (at: number, word: number): void => {
		if (at >= 0 && at + 4 <= bytes.length) data().setUint32(at, word >>> 0, true)
	}

	for (let count = 1 + random.below(4); count > 0; count--) {
		switch (random.below(8)) {
			case 0:
				// A header count or start sector.
				put(random.pick([0x28, 0x2c, 0x30, 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x50]), value())
				break
			case 1:
				// A DIFAT slot.
				put(0x4c + random.below(109) * 4, value())
				break
			case 2: {
				// A FAT entry: a chain bent onto itself, another chain, or anywhere.
				const fat = get(0x4c)
				const index = random.below(sectorSize / 4)

				if (fat < sectors) put((fat + 1) * sectorSize + index * 4, random.below(2) === 0 ? index - random.below(4) : value())
				break
			}
			case 3:
			case 4: {
				// A directory entry's links, type, name length, start or size.
				const directory = get(0x30)

				if (directory >= sectors) break

				const at = (directory + 1) * sectorSize + random.below(sectorSize / 128) * 128
				const field = random.pick([0x40, 0x42, 0x44, 0x48, 0x4c, 0x74, 0x78, 0x7c])

				if (field === 0x42 && at + 0x42 < bytes.length) bytes[at + 0x42] = random.pick([0, 1, 2, 5, 9])
				else if (field === 0x40 && at + 0x42 <= bytes.length) data().setUint16(at + 0x40, random.below(80), true)
				else put(at + field, value())
				break
			}
			case 5: {
				// A mini FAT entry.
				const miniFat = get(0x3c)

				if (miniFat < sectors) put((miniFat + 1) * sectorSize + random.below(sectorSize / 4) * 4, value())
				break
			}
			case 6:
				bytes = bytes.slice(0, random.below(bytes.length + 1))
				break
			default:
				for (let k = 1 + random.below(16); k > 0; k--)
					if (bytes.length > 0) bytes[random.below(bytes.length)] = random.next() & 0xff
		}
	}

	return bytes
}

interface Outcome {
	readonly untyped: string | undefined
	readonly ms: number
	readonly read: boolean
}

async function exercise(bytes: Uint8Array, random: Random): Promise<Outcome> {
	const started = performance.now()
	let read = false

	try {
		const file = await CfbFile.open(bytesSource(bytes))

		for (const entry of file.walk()) {
			if (entry.kind !== "stream") continue

			try {
				await file.read(entry)

				const source = file.stream(entry)
				const from = random.below(source.size + 1)

				await source.read(from, random.below(source.size - from + 1))
				read = true
			} catch (error) {
				if (!(error instanceof CfbError)) throw error
			}
		}
	} catch (error) {
		if (!(error instanceof CfbError)) return { untyped: String(error), ms: performance.now() - started, read }
	}

	return { untyped: undefined, ms: performance.now() - started, read }
}

describe("compound file reader under mutation", () => {
	it(`answers ${MUTANTS} mutated files with typed errors only, each within ${BOUND_MS} ms`, { timeout: 600_000 }, async () => {
		const random = new Random(SEED)
		const sources = await seeds()
		const untyped: string[] = []
		let slowest = 0
		let readSome = 0

		for (let k = 0; k < MUTANTS; k++) {
			const outcome = await exercise(mutate(random.pick(sources), random), random)

			if (outcome.untyped !== undefined) untyped.push(`#${k} (seed ${SEED}): ${outcome.untyped}`)
			if (outcome.read) readSome++

			slowest = Math.max(slowest, outcome.ms)
		}

		expect(untyped).toEqual([])
		expect(slowest, `seed ${SEED}`).toBeLessThan(budget(BOUND_MS))
		// The mutants still reach the stream reader, not only the header checks.
		expect(readSome).toBeGreaterThan(MUTANTS / 10)
	})
})
