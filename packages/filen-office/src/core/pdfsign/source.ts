import type { PdfDigestName } from "./types"

// The file's bytes, read on demand (a range port on web, a buffer in tests). Nothing here holds more than one run.
export interface PdfByteSource {
	readonly length: number
	read(offset: number, length: number): Promise<Uint8Array>
}

// An incremental hash (hash-wasm on web): WebCrypto has no streaming digest.
export interface PdfDigest {
	update(bytes: Uint8Array): void
	digest(): Uint8Array
}

export type PdfDigestFactory = (name: PdfDigestName) => Promise<PdfDigest>

// Digests stream through runs of this size: large enough to amortise a read, small enough to never matter.
export const DIGEST_RUN_BYTES = 4 * 1024 * 1024

export class PdfSourceError extends Error {
	override readonly name = "PdfSourceError"

	constructor() {
		super("read failed")
	}
}

// Reads exactly [offset, offset + length), joining short reads.
export async function readExactly(source: PdfByteSource, offset: number, length: number): Promise<Uint8Array> {
	if (length <= 0) return new Uint8Array(0)
	if (offset < 0 || offset + length > source.length) throw new PdfSourceError()

	const first = await source.read(offset, length)

	if (first.length === length) return first
	if (first.length === 0 || first.length > length) throw new PdfSourceError()

	const out = new Uint8Array(length)
	let filled = 0

	out.set(first)
	filled = first.length

	while (filled < length) {
		const chunk = await source.read(offset + filled, length - filled)

		if (chunk.length === 0 || chunk.length > length - filled) throw new PdfSourceError()

		out.set(chunk, filled)
		filled += chunk.length
	}

	return out
}

// Hashes the given byte ranges of the source with every named digest in one pass.
export async function digestRanges(
	source: PdfByteSource,
	ranges: readonly (readonly [number, number])[],
	names: readonly PdfDigestName[],
	createDigest: PdfDigestFactory,
	signal?: { readonly aborted: boolean }
): Promise<Map<PdfDigestName, Uint8Array>> {
	const unique = [...new Set(names)]
	const digests = await Promise.all(unique.map(name => createDigest(name)))

	for (const [start, length] of ranges) {
		for (let at = start; at < start + length; at += DIGEST_RUN_BYTES) {
			if (signal?.aborted === true) throw new PdfSourceError()

			const run = await readExactly(source, at, Math.min(DIGEST_RUN_BYTES, start + length - at))

			for (const digest of digests) digest.update(run)
		}
	}

	return new Map(unique.map((name, i) => [name, digests[i]?.digest() ?? new Uint8Array(0)]))
}

export async function digestBytes(bytes: Uint8Array, name: PdfDigestName, createDigest: PdfDigestFactory): Promise<Uint8Array> {
	const digest = await createDigest(name)

	digest.update(bytes)

	return digest.digest()
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	let diff = 0

	for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)

	return diff === 0
}
