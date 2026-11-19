import { createHash } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { ZipArchive, ZipError, bytesSource, sliceClock, type InflateHook, type ZipEntry } from "@filen/office/core/opc"
import { translateOdt } from "../core/odt/index"
import { odtBytes } from "./odtFixtures"
import { buildZip, sameBytes, text, type BuildEntry } from "./zipBuilder"

// ZipArchive.stream: an entry's content in chunks, never whole, checked as read() checks it.

const nativeInflate: InflateHook = input => ReadableStream.from(input).pipeThrough(new DecompressionStream("deflate-raw"))

function repetitive(size: number): Uint8Array {
	const out = new Uint8Array(size)

	for (let i = 0; i < size; i++) out[i] = (i * 7 + (i >> 9)) & 0xff

	return out
}

function entryOf(archive: ZipArchive, name: string): ZipEntry {
	const entry = archive.get(name)

	if (entry === undefined) throw new Error(`no ${name}`)

	return entry
}

async function collect(archive: ZipArchive, name: string): Promise<{ bytes: Uint8Array; largest: number; chunks: number }> {
	const parts: Uint8Array[] = []
	let largest = 0

	for await (const chunk of archive.stream(entryOf(archive, name))) {
		// A chunk is the caller's until the next one is asked for: copied here, as a consumer that keeps it must.
		parts.push(chunk.slice())
		largest = Math.max(largest, chunk.length)
	}

	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		bytes.set(part, at)
		at += part.length
	}

	return { bytes, largest, chunks: parts.length }
}

async function failure(run: () => Promise<unknown>): Promise<string> {
	try {
		await run()
	} catch (error) {
		return error instanceof ZipError ? `${error.code}: ${error.message}` : `not a ZipError: ${String(error)}`
	}

	return "no error"
}

const BIG = repetitive(3 * 1024 * 1024)

describe("ZipArchive.stream", () => {
	for (const [label, inflate] of [
		["fflate", undefined],
		["a native inflate", nativeInflate]
	] as const) {
		it(`streams a deflated entry in bounded chunks through ${label}`, async () => {
			const archive = await ZipArchive.open(
				bytesSource(buildZip([{ name: "big.xml", data: BIG }])),
				inflate === undefined ? {} : { inflate }
			)
			const { bytes, largest, chunks } = await collect(archive, "big.xml")

			expect(sameBytes(bytes, BIG)).toBe(true)
			expect(largest).toBeLessThanOrEqual(2 * 1024 * 1024)
			expect(chunks).toBeGreaterThan(4)
		})
	}

	it("streams a stored entry in bounded views", async () => {
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "s.bin", data: BIG, method: 0 }])))
		const { bytes, largest } = await collect(archive, "s.bin")

		expect(sameBytes(bytes, BIG)).toBe(true)
		expect(largest).toBeLessThanOrEqual(1024 * 1024)
	})

	it("streams an empty entry as nothing", async () => {
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "e", data: new Uint8Array(0) }])))

		expect((await collect(archive, "e")).bytes.length).toBe(0)
	})

	it("fails a CRC mismatch, a short entry and an overlong one exactly as read() does", async () => {
		const data = text("hello world, hello world, hello world")
		const cases = [
			buildZip([{ name: "a", data, crc: 0x12345678 }]),
			buildZip([{ name: "a", data, uncompressedSize: data.length + 5 }]),
			buildZip([{ name: "a", data, uncompressedSize: data.length - 5 }]),
			buildZip([{ name: "a", data, method: 0, crc: 1 }]),
			buildZip([{ name: "a", data: text("x"), compressed: new Uint8Array([0xff, 0xff, 0xff]) }])
		]

		for (const zip of cases) {
			for (const inflate of [undefined, nativeInflate]) {
				const archive = await ZipArchive.open(bytesSource(zip), inflate === undefined ? {} : { inflate })
				const read = await failure(() => archive.read(entryOf(archive, "a")))
				const streamed = await failure(() => collect(archive, "a"))

				expect(read).not.toBe("no error")
				expect(streamed).toBe(read)
			}
		}
	})

	it("stops inflating once the entry outgrows its declared size", async () => {
		const bomb = deflateRawSync(new Uint8Array(64 * 1024 * 1024))
		const archive = await ZipArchive.open(
			bytesSource(buildZip([{ name: "bomb", data: new Uint8Array(1000), compressed: bomb, uncompressedSize: 1000 }]))
		)
		let seen = 0
		const message = await failure(async () => {
			for await (const chunk of archive.stream(entryOf(archive, "bomb"))) seen += chunk.length
		})

		expect(message).toContain("inflates past its declared size")
		expect(seen).toBeLessThanOrEqual(1000)
	})

	for (const [label, inflate] of [
		["fflate", undefined],
		["a native inflate", nativeInflate]
	] as const) {
		it(`gives the host its turns between steps of a highly compressible entry through ${label}`, async () => {
			const zeros = new Uint8Array(16 * 1024 * 1024)
			const archive = await ZipArchive.open(
				bytesSource(buildZip([{ name: "zeros", data: zeros }])),
				inflate === undefined ? {} : { inflate }
			)
			const events: string[] = []
			// Always due: a turn after every step.
			const clock = sliceClock({ sliceMs: 0, now: () => 0, pause: async () => void events.push("pause") })
			let largest = 0
			let total = 0

			for await (const chunk of archive.stream(entryOf(archive, "zeros"), clock)) {
				events.push("chunk")
				largest = Math.max(largest, chunk.length)
				total += chunk.length
			}

			expect(total).toBe(zeros.length)
			expect(events[0]).toBe("chunk")
			expect(events.filter(event => event === "pause").length).toBeGreaterThan(4)
			expect(events.join(" ")).not.toContain("pause pause")
			expect(largest).toBeLessThanOrEqual(2 * 1024 * 1024)
		})
	}

	it("passes what the host's turn throws through as it is", async () => {
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "big.xml", data: BIG }])))
		const cancelled = new Error("cancelled")
		const clock = sliceClock({ sliceMs: 0, now: () => 0, pause: () => Promise.reject(cancelled) })
		let caught: unknown

		try {
			for await (const chunk of archive.stream(entryOf(archive, "big.xml"), clock)) void chunk
		} catch (error) {
			caught = error
		}

		expect(caught).toBe(cancelled)
	})

	it("refuses a compression method it does not read", async () => {
		const archive = await ZipArchive.open(bytesSource(buildZip([{ name: "m", data: text("x"), method: 99 }])))

		expect(await failure(() => collect(archive, "m"))).toBe(await failure(() => archive.read(entryOf(archive, "m"))))
	})

	it("classes a deflated picture of incompressible bytes whose first steps inflate nothing", async () => {
		// zlib writes incompressible data as stored deflate blocks: nothing inflates until a whole block is in, so the
		// first chunks stream() yields are empty.
		const image = new Uint8Array(200_000)

		for (let at = 0; at < image.length; at += 32) {
			image.set(
				createHash("sha256")
					.update(String(at))
					.digest()
					.subarray(0, image.length - at),
				at
			)
		}

		image.set([0xff, 0xd8, 0xff, 0xe0])

		const source = await ZipArchive.open(
			bytesSource(
				odtBytes({
					body: '<text:p><draw:frame text:anchor-type="as-char" svg:width="1cm" svg:height="1cm"><draw:image xlink:href="Pictures/a.jpg"/></draw:frame></text:p>'
				})
			)
		)
		const zip = buildZip([
			...(await Promise.all(
				source.entries.map(async item => ({
					name: item.name,
					data: await source.read(item),
					method: item.method === 0 ? (0 as const) : (8 as const)
				}))
			)),
			{ name: "Pictures/a.jpg", data: image, compressed: deflateRawSync(image) }
		])
		const archive = await ZipArchive.open(bytesSource(zip))
		const first = await archive.stream(entryOf(archive, "Pictures/a.jpg"))[Symbol.asyncIterator]().next()

		expect(first.done === true ? -1 : first.value.length).toBe(0)

		const result = await translateOdt(bytesSource(zip))

		if (!result.ok) throw new Error(result.message)

		expect(result.translation.parts.has("word/media/image1.jpeg")).toBe(true)
	})

	it("fails an ODT whose content.xml is damaged or the wrong size with the errors read() gives", async () => {
		const source = await ZipArchive.open(bytesSource(odtBytes({ body: "<text:p>Hello, hello, hello</text:p>" })))
		const content = await source.read(entryOf(source, "content.xml"))
		const odt = async (entry: Omit<BuildEntry, "name" | "data">): Promise<Uint8Array> =>
			buildZip(
				await Promise.all(
					source.entries.map(async item => ({
						name: item.name,
						data: await source.read(item),
						method: item.method === 0 ? (0 as const) : (8 as const),
						...(item.name === "content.xml" ? entry : {})
					}))
				)
			)
		const cases = [
			await odt({ compressed: new Uint8Array([0xff, 0xff, 0xff]) }),
			await odt({ uncompressedSize: content.length + 5 }),
			await odt({ uncompressedSize: content.length - 5 })
		]

		for (const zip of cases) {
			const archive = await ZipArchive.open(bytesSource(zip))
			const read = await failure(() => archive.read(entryOf(archive, "content.xml")))
			const result = await translateOdt(bytesSource(zip))

			expect(read).toMatch(/^corrupt: /u)
			expect(result.ok ? "no error" : `corrupt: ${result.message}`).toBe(read)
		}
	})
})
