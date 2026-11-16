import { BlockCache } from "@/lib/media/blockCache"
import { raceAbort } from "@/lib/abort"
import { originSize, type ByteOrigin } from "@/lib/sdk/byteOrigin"
import { openOriginRangeSource } from "@/features/preview/lib/origin/rangeSource"

// Random reads of an origin for a parser on the page (a sniff, a header walk). Reads past the end are cut short.
// The bytes returned may be views of the reader's memo: copy them before transferring.
export interface ByteReader {
	readonly size: number
	read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
	close(): void
}

export interface ByteReaderOptions {
	// SDK blocks kept for revisits.
	readonly blocks?: number
}

const DEFAULT_BLOCKS = 4

function clamp(size: number, offset: number, length: number): { start: number; end: number } {
	const start = Math.max(0, Math.min(offset, size))

	return { start, end: Math.max(start, Math.min(size, start + Math.max(0, length))) }
}

// A `bytes` origin reads its Blob directly; the others read whole SDK blocks through a range port, memoised.
export async function openByteReader(origin: ByteOrigin, token: string, options?: ByteReaderOptions): Promise<ByteReader> {
	if (origin.kind === "bytes") {
		const { blob } = origin

		return {
			size: blob.size,
			read: async (offset, length, signal) => {
				signal?.throwIfAborted()

				const { start, end } = clamp(blob.size, offset, length)
				const bytes = new Uint8Array(await blob.slice(start, end).arrayBuffer())

				signal?.throwIfAborted()

				return bytes
			},
			close: () => undefined
		}
	}

	const source = await openOriginRangeSource(origin, token)
	const size = originSize(origin)
	const blocks = new BlockCache(size, source.reader.readRange, { capacity: options?.blocks ?? DEFAULT_BLOCKS, readAhead: 0 })

	return {
		size,
		read: async (offset, length, signal) => {
			signal?.throwIfAborted()

			const { start, end } = clamp(size, offset, length)

			if (start === end) {
				return new Uint8Array(0)
			}

			return await raceAbort(Promise.resolve(blocks.read(start, end)), signal)
		},
		close: () => {
			blocks.dispose()
			source.close()
		}
	}
}
