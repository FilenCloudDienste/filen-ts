import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { unzipSync, zlibSync } from "fflate"
import { describe, expect, it, vi } from "vitest"
import { ITEM_INTS } from "../core/drawingml/displayList"
import { Bytes } from "../core/metafile/bytes"
import { convertMetafile, type MetafileConversion } from "../core/metafile/index"
import { MAX_DECODE_PIXELS } from "../core/metafile/limits"
import { convertSvm } from "../core/metafile/svm"
import { CORPUS_DIR as CORPUS } from "./corpusDir"
import { ByteWriter, EmfBuilder, WmfBuilder, plusHeader, plusRecord } from "./metafileFixtures"
import { liveHeapNow } from "./liveHeap"
import { budget, cpuMs } from "./timing"

// Adversarial input: each case must end quickly with bounded memory (playback stops at a limit and keeps
// what it drew) and never throw.

// Heap and ArrayBuffer backing stores (heapUsed leaves the latter out, and the lists are typed arrays). Collected
// before the call (`settle`; too slow for thousands of small fuzz rounds), so earlier cases' garbage is not freed during
// it and does not offset the growth; never after, since that would free a transient allocation from a declared size
// before it is seen.
function used(): number {
	const usage = process.memoryUsage()

	return usage.heapUsed + usage.arrayBuffers
}

function timed(bytes: Uint8Array, settle = true): { result: MetafileConversion; ms: number; heap: number } {
	const heap = settle ? liveHeapNow() : used()
	const start = cpuMs()
	const result = convertMetafile(bytes)

	return { result, ms: cpuMs() - start, heap: used() - heap }
}

// What a conversion keeps (the list's arrays, spare capacity included) grows with its input, never with the counts or
// sizes the input declares. A shape record expands: a 14-byte WMF ellipse keeps about 3 elements per input byte.
function expectKeptWithin(result: MetafileConversion, bytes: Uint8Array): void {
	if (!result.ok) return

	const { list } = result

	expect(list.commands.length + list.coords.length + list.itemInts.length / ITEM_INTS).toBeLessThan(16 * bytes.length + 1024)
}

const BUFFERS = [
	"ArrayBuffer",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array"
] as const

// Bytes of every ArrayBuffer and typed array `run` constructs (views over an existing buffer excluded), freed or
// kept: a transient allocation from a declared size is counted whether or not a collection would free it.
function allocated<T>(run: () => T): { value: T; bytes: number } {
	const Buffer = ArrayBuffer
	let bytes = 0

	for (const name of BUFFERS) {
		const constructor = globalThis[name]

		vi.stubGlobal(
			name,
			new Proxy(constructor, {
				construct(target, args, newTarget) {
					const made = Reflect.construct(target, args, newTarget) as ArrayBuffer | ArrayBufferView

					if (!(args[0] instanceof Buffer)) bytes += made.byteLength

					return made
				}
			})
		)
	}

	try {
		const value = run()

		return { value, bytes }
	} finally {
		vi.unstubAllGlobals()
	}
}

// EMF+ records grouped into comments of at most 1000 records.
function plusFile(records: readonly Uint8Array[]): Uint8Array {
	const builder = new EmfBuilder().plus([plusHeader(false)])

	for (let k = 0; k < records.length; k += 1000) builder.plus(records.slice(k, k + 1000))

	return builder.build()
}

function floatPath(points: number): Uint8Array {
	return plusRecord(0x4008, 0x0300, writer => {
		writer.u32(0xdbc01002).u32(points).u32(0)

		for (let k = 0; k < points; k++) writer.f32(k % 100).f32((k * 7) % 100)
		for (let k = 0; k < points; k++) writer.u8(k === 0 ? 0 : 1)

		writer.pad(4)
	})
}

// An EMF+ region object (slot 0): a balanced tree of `depth` levels of Union nodes over small path leaves.
function unionRegion(depth: number): Uint8Array {
	const node = (writer: ByteWriter, level: number, at: number): void => {
		if (level === 0) {
			const path = new ByteWriter().u32(0xdbc01002).u32(3).u32(0)

			path.f32(at % 100)
				.f32(0)
				.f32((at % 100) + 1)
				.f32(1)
				.f32(at % 100)
				.f32(2)
				.u8(0)
				.u8(1)
				.u8(0x81)
				.pad(4)

			const bytes = path.done()

			writer.u32(0x10000001).u32(bytes.length).raw(bytes)

			return
		}

		writer.u32(2)
		node(writer, level - 1, at * 2)
		node(writer, level - 1, at * 2 + 1)
	}

	return plusRecord(0x4008, 0x0400, writer => {
		writer.u32(0xdbc01002).u32(2 ** (depth + 1) - 2)
		node(writer, depth, 0)
	})
}

// A StarView metafile in 1/100 mm whose actions are (type, body) pairs.
function svmFile(actions: readonly [number, Uint8Array][]): Uint8Array {
	const mapMode = new ByteWriter().u16(0).i32(0).i32(0).i32(1).i32(1).i32(1).i32(1).u8(0).done()
	const header = new ByteWriter().u32(0).u16(1).u32(mapMode.length).raw(mapMode).i32(2540).i32(2540).u32(actions.length).done()
	const out = new ByteWriter().ascii("VCLMTF").u16(1).u32(header.length).raw(header)

	for (const [type, body] of actions) out.u16(type).u16(1).u32(body.length).raw(body)

	return out.done()
}

// A BmpScale action: a 4096 x 4096 32-bit ZCodec DIB (the most one bitmap may declare) of zeros.
function zcodecBitmap(coded: Uint8Array): Uint8Array {
	const size = MAX_DECODE_PIXELS * 4

	return new ByteWriter()
		.u8(0x42)
		.u8(0x4d)
		.u32(54 + size)
		.u32(0)
		.u32(54)
		.u32(40)
		.i32(4096)
		.i32(4096)
		.u16(1)
		.u16(32)
		.u32(0x01004453)
		.u32(size)
		.i32(0)
		.i32(0)
		.u32(0)
		.u32(0)
		.u32(coded.length)
		.u32(size)
		.u32(0)
		.raw(coded)
		.i32(0)
		.i32(0)
		.i32(2540)
		.i32(2540)
		.done()
}

describe("metafile limits", () => {
	it("charges ZCodec bitmaps' inflated bytes before inflating them, drawn or not", { timeout: budget(120_000) }, () => {
		const bitmap = zcodecBitmap(zlibSync(new Uint8Array(MAX_DECODE_PIXELS * 4)))
		const many: [number, Uint8Array][] = Array.from({ length: 40 }, () => [117, bitmap])
		// XOR: nothing is drawn, so the decoding budget is never spent.
		const xor: [number, Uint8Array] = [141, new ByteWriter().u16(2).done()]

		for (const actions of [many, [xor, ...many]]) {
			const start = performance.now()
			const result = convertSvm(new Bytes(svmFile(actions)))

			expect(result.ok && result.truncated).toBe(true)
			expect(performance.now() - start).toBeLessThan(budget(10_000))
		}

		const single = convertSvm(new Bytes(svmFile([[117, bitmap]])))

		expect(single.ok && !single.truncated && single.list.images.length).toBe(1)
	})

	it("charges region evaluation: a large region replayed as the clip ends at the work budget", { timeout: budget(120_000) }, () => {
		// 4095 nodes a replay: the work budget ends playback after about 15 600 of the 20 000.
		const records = [unionRegion(11)]

		for (let k = 0; k < 20_000; k++) records.push(plusRecord(0x4034, 0))

		const bytes = plusFile(records)
		const cpu = cpuMs()
		const result = convertMetafile(bytes)

		expect(result.ok && result.truncated).toBe(true)
		expect(cpuMs() - cpu).toBeLessThan(budget(30_000))

		const small = [unionRegion(2)]

		for (let k = 0; k < 5000; k++) small.push(plusRecord(0x4034, 0))

		const legitimate = convertMetafile(plusFile(small))

		expect(legitimate.ok && legitimate.truncated).toBe(false)
	})

	it("bounds clip work on a large path set as the clip over and over", { timeout: budget(60_000) }, () => {
		for (const mode of [0, 1, 2, 3, 4, 5]) {
			const records = [floatPath(50_000)]

			for (let k = 0; k < 1000; k++) records.push(plusRecord(0x4033, mode << 8))

			const bytes = plusFile(records)
			const { result, ms, heap } = timed(bytes)

			expect(result.ok).toBe(true)
			expectKeptWithin(result, bytes)
			expect(ms).toBeLessThan(budget(5000))
			expect(heap).toBeLessThan(256 * 1024 * 1024)
		}
	})

	it("bounds repeated clip rectangles and their unions", { timeout: budget(60_000) }, () => {
		const builder = new WmfBuilder().record(0x20c, [1000, 1000])

		for (let k = 0; k < 200_000; k++) builder.record(k % 2 === 0 ? 0x416 : 0x415, [1000 - (k % 7), 1000 - (k % 5), k % 3, k % 11])

		builder.record(0x41b, [10, 10, 0, 0])

		const bytes = builder.build([0, 0, 1000, 1000])
		const { result, ms, heap } = timed(bytes)

		expect(result.ok).toBe(true)
		expectKeptWithin(result, bytes)
		expect(ms).toBeLessThan(budget(5000))
		expect(heap).toBeLessThan(256 * 1024 * 1024)
	})

	it("allocates nothing from declared sizes: continued objects and path point counts", () => {
		const continued: Uint8Array[] = []

		for (let k = 0; k < 20_000; k++) continued.push(plusRecord(0x4008, 0x8000 | (1 << 8) | (k & 1), writer => writer.u32(3_000_000)))

		const declaredPaths: Uint8Array[] = []

		for (let k = 0; k < 2000; k++)
			declaredPaths.push(plusRecord(0x4008, 0x0300 | (k & 63), writer => writer.u32(0xdbc01002).u32(1_000_000).u32(0x0800).u32(0)))

		for (const records of [continued, declaredPaths]) {
			const bytes = plusFile(records)
			const { result, ms, heap } = timed(bytes)

			expect(result.ok).toBe(true)
			expectKeptWithin(result, bytes)
			expect(ms).toBeLessThan(budget(2000))
			expect(heap).toBeLessThan(32 * 1024 * 1024)

			// Measured: under 1 byte allocated per input byte; one array sized from a declared count is gigabytes.
			const counted = allocated(() => convertMetafile(bytes))

			expect(counted.value.ok).toBe(true)
			expect(counted.bytes).toBeLessThan(4 * bytes.length)
		}
	})

	it("refuses bitmaps a browser would decode into a huge canvas", () => {
		const info = new ByteWriter()
			.u32(40)
			.i32(40_000)
			.i32(40_000)
			.u16(1)
			.u16(8)
			.u32(1)
			.u32(4)
			.u32(0)
			.u32(0)
			.u32(2)
			.u32(0)
			.u32(0xff0000)
			.u32(0xff00)
			.done()
		const bits = Uint8Array.of(0, 1)
		const bytes = new EmfBuilder()
			.record(81, writer =>
				writer
					.i32(0)
					.i32(0)
					.i32(100)
					.i32(100)
					.i32(0)
					.i32(0)
					.i32(0)
					.i32(0)
					.i32(40_000)
					.i32(40_000)
					.u32(80)
					.u32(info.length)
					.u32(80 + info.length)
					.u32(bits.length)
					.u32(0)
					.u32(0x00cc0020)
					.i32(96)
					.i32(96)
					.raw(info)
					.raw(bits)
			)
			.build()
		const result = convertMetafile(bytes)

		expect(result.ok && result.list.images.length).toBe(0)
	})
})

// Seeds from the corpus, mutated: random bytes and runs of 0xFF (huge counts and sizes) in random places.
function seeds(): Uint8Array[] {
	const out: Uint8Array[] = []

	for (const extension of ["docx", "docm", "dotx", "dotm"]) {
		const directory = join(CORPUS, extension)

		if (!existsSync(directory)) continue

		for (const name of readdirSync(directory).sort()) {
			try {
				const parts = unzipSync(new Uint8Array(readFileSync(join(directory, name))), {
					filter: entry => /\.(emf|wmf)$/i.test(entry.name)
				})

				for (const bytes of Object.values(parts)) if (bytes.length < 400_000) out.push(bytes)
			} catch {
				continue
			}
		}
	}

	return out
}

describe.skipIf(!existsSync(CORPUS))("metafile fuzzing over corpus seeds", () => {
	it("converts mutated corpus metafiles without failing, quickly and within memory", { timeout: budget(600_000) }, () => {
		const corpus = seeds()
		let seed = 99
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff

			return seed / 0x7fffffff
		}
		const failures: string[] = []
		let worst = 0
		let worstHeap = 0

		for (let round = 0; round < 3000 && corpus.length > 0; round++) {
			const source = corpus[Math.floor(random() * corpus.length)] ?? new Uint8Array(0)
			const mutated = source.slice()
			const changes = 1 + Math.floor(random() * 8)

			for (let k = 0; k < changes; k++) {
				const at = Math.floor(random() * mutated.length)

				if (random() < 0.5) {
					mutated[at] = Math.floor(random() * 256)
				} else {
					mutated[at] = 0xff
					mutated[at + 1] = 0xff
					mutated[at + 2] = random() < 0.5 ? 0xff : 0x0f
				}
			}

			const { result, ms, heap } = timed(mutated, false)

			expectKeptWithin(result, mutated)
			if (!result.ok && result.reason === "failed") failures.push(`round ${round} (seed of ${source.length} bytes)`)

			worst = Math.max(worst, ms)
			worstHeap = Math.max(worstHeap, heap)
		}

		console.log(
			`metafile fuzz: ${corpus.length} seeds, worst ${worst.toFixed(0)} ms, worst heap growth ${(worstHeap / 1048576).toFixed(0)} MiB`
		)

		expect(failures).toEqual([])
		expect(worst).toBeLessThan(budget(3000))
		expect(worstHeap).toBeLessThan(512 * 1024 * 1024)
	})
})
