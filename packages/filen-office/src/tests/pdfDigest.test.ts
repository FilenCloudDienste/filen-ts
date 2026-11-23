import { createHash, webcrypto } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { DIGEST_RUN_BYTES, digestRanges, type PdfDigestName } from "../core/pdfsign"
import { ONE_SHOT_BYTES, createPdfDigest, pdfDigestFactory, type PdfDigestSubtle } from "../dom/pdfedit/digest"

const NAMES: readonly PdfDigestName[] = ["SHA-256", "SHA-384", "SHA-512"]
const NODE_NAMES: Readonly<Record<PdfDigestName, string>> = { "SHA-256": "sha256", "SHA-384": "sha384", "SHA-512": "sha512" }

// FIPS 180-4 example messages.
const ABC = new TextEncoder().encode("abc")
const TWO_BLOCKS = new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
const VECTORS: readonly (readonly [PdfDigestName, Uint8Array, string])[] = [
	["SHA-256", new Uint8Array(0), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
	["SHA-256", ABC, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
	["SHA-256", TWO_BLOCKS, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"],
	["SHA-384", ABC, "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"],
	[
		"SHA-512",
		ABC,
		"ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
	]
]

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex")
}

function nodeDigest(name: PdfDigestName, bytes: Uint8Array): string {
	return createHash(NODE_NAMES[name]).update(bytes).digest("hex")
}

function countingSubtle(): PdfDigestSubtle & { readonly calls: number[] } {
	const calls: number[] = []

	return {
		calls,
		digest: (name, data) => {
			calls.push(data.length)

			return webcrypto.subtle.digest(name, data)
		}
	}
}

async function digestChunks(
	factory: ReturnType<typeof pdfDigestFactory>,
	name: PdfDigestName,
	chunks: readonly Uint8Array[],
	length?: number
): Promise<string> {
	const digest = await factory(name, length)

	for (const chunk of chunks) digest.update(chunk)

	return hex(await digest.digest())
}

describe("createPdfDigest", () => {
	it.each(VECTORS)("%s matches the FIPS 180-4 example on WebCrypto, noble and an unannounced length", async (name, message, expected) => {
		const subtle = countingSubtle()

		expect(await digestChunks(pdfDigestFactory(subtle), name, [message], message.length)).toBe(expected)
		expect(subtle.calls).toEqual([message.length])
		expect(await digestChunks(pdfDigestFactory(undefined), name, [message], message.length)).toBe(expected)
		expect(await digestChunks(pdfDigestFactory(subtle), name, [message])).toBe(expected)
		expect(subtle.calls).toHaveLength(1)
		expect(await digestChunks(createPdfDigest, name, [message], message.length)).toBe(expected)
	})

	it("hashes chunks in one WebCrypto call, copying each so a later change to the caller's view does not count", async () => {
		const subtle = countingSubtle()
		const bytes = new Uint8Array(1000).map((_, i) => i * 7)
		const expected = nodeDigest("SHA-256", bytes)
		const digest = await pdfDigestFactory(subtle)("SHA-256", bytes.length)
		const view = bytes.slice(0, 400)

		digest.update(view)
		view.fill(0)
		digest.update(bytes.subarray(400))

		expect(hex(await digest.digest())).toBe(expected)
		expect(subtle.calls).toEqual([1000])
	})

	it("hashes only what was given when less than announced", async () => {
		const subtle = countingSubtle()

		expect(await digestChunks(pdfDigestFactory(subtle), "SHA-384", [ABC], 64)).toBe(nodeDigest("SHA-384", ABC))
		expect(subtle.calls).toEqual([3])
	})

	it("streams once given more than announced", async () => {
		const subtle = countingSubtle()
		const bytes = new Uint8Array(300).map((_, i) => i)

		for (const name of NAMES) {
			expect(
				await digestChunks(
					pdfDigestFactory(subtle),
					name,
					[bytes.subarray(0, 100), bytes.subarray(100, 250), bytes.subarray(250)],
					120
				)
			).toBe(nodeDigest(name, bytes))
		}

		expect(subtle.calls).toEqual([])
	})

	it("streams an input larger than one WebCrypto call is allowed", async () => {
		const subtle = countingSubtle()
		const bytes = new Uint8Array(ONE_SHOT_BYTES + 1).fill(0x5a)
		const chunks = [bytes.subarray(0, DIGEST_RUN_BYTES), bytes.subarray(DIGEST_RUN_BYTES)]

		expect(await digestChunks(pdfDigestFactory(subtle), "SHA-512", chunks, bytes.length)).toBe(nodeDigest("SHA-512", bytes))
		expect(subtle.calls).toEqual([])
	})
})

describe("digestRanges", () => {
	it("announces the ranges' total length and skips the gap", async () => {
		const file = new Uint8Array(DIGEST_RUN_BYTES + 200).map((_, i) => i % 251)
		const ranges = [
			[0, DIGEST_RUN_BYTES + 10],
			[DIGEST_RUN_BYTES + 50, 150]
		] as const
		const signed = new Uint8Array([...file.subarray(0, DIGEST_RUN_BYTES + 10), ...file.subarray(DIGEST_RUN_BYTES + 50)])
		const subtle = countingSubtle()
		const factory = vi.fn(pdfDigestFactory(subtle))
		const digests = await digestRanges(
			{ length: file.length, read: (offset, length) => Promise.resolve(file.slice(offset, offset + length)) },
			ranges,
			["SHA-256", "SHA-512", "SHA-256"],
			factory
		)

		expect(factory.mock.calls).toEqual([
			["SHA-256", signed.length],
			["SHA-512", signed.length]
		])
		expect(subtle.calls).toEqual([signed.length, signed.length])
		expect([...digests].map(([name, digest]) => [name, hex(digest)])).toEqual([
			["SHA-256", nodeDigest("SHA-256", signed)],
			["SHA-512", nodeDigest("SHA-512", signed)]
		])
	})
})
