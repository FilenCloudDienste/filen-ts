// Random-access input: mobile reads ranges of the file on disk, web wraps bytes it already holds.
export interface ByteSource {
	readonly size: number
	read(offset: number, length: number): Promise<Uint8Array>
	// The bytes with their CRC-32 continued from `crc`, computed where the bytes live (a source on another
	// thread checksums its own copy before sending it, so what arrives can be checked against it).
	readChecked?(offset: number, length: number, crc: number): Promise<{ readonly bytes: Uint8Array; readonly crc: number }>
}

// Streamed output. The writer never touches a chunk again once it is written, so a sink may keep it.
export interface ByteSink {
	write(chunk: Uint8Array): Promise<void>
	close(): Promise<void>
}

// A source over bytes in memory; reads are views, never copies.
export function bytesSource(bytes: Uint8Array): ByteSource {
	return {
		size: bytes.length,
		read(offset: number, length: number): Promise<Uint8Array> {
			if (offset < 0 || length < 0 || offset + length > bytes.length) {
				return Promise.reject(new RangeError("Read outside the source"))
			}

			return Promise.resolve(bytes.subarray(offset, offset + length))
		}
	}
}

export interface MemorySink extends ByteSink {
	// Everything written, as one array (the single chunk itself when only one was written). Joining copies: a
	// consumer that can read the chunks (chunksSource) holds the bytes once.
	bytes(): Uint8Array
	// Everything written, as written.
	chunks(): readonly Uint8Array[]
}

// A source over chunks laid end to end: a read inside one chunk is a view, a read across chunks is copied (only those
// bytes), so a zip written in pieces is read back without first being joined into one array.
export function chunksSource(chunks: readonly Uint8Array[]): ByteSource {
	const starts = new Float64Array(chunks.length + 1)

	for (let k = 0; k < chunks.length; k++) starts[k + 1] = (starts[k] ?? 0) + (chunks[k]?.length ?? 0)

	const size = starts[chunks.length] ?? 0
	// The chunk holding `offset` (the last whose start is at or before it).
	const chunkAt = (offset: number): number => {
		let low = 0
		let high = chunks.length - 1

		while (low < high) {
			const middle = (low + high + 1) >>> 1

			if ((starts[middle] ?? 0) <= offset) low = middle
			else high = middle - 1
		}

		return low
	}

	return {
		size,
		read(offset: number, length: number): Promise<Uint8Array> {
			if (offset < 0 || length < 0 || offset + length > size) return Promise.reject(new RangeError("Read outside the source"))

			let index = chunkAt(offset)
			const first = chunks[index]
			const start = starts[index] ?? 0

			if (first === undefined || length === 0) return Promise.resolve(new Uint8Array(0))
			if (offset + length <= start + first.length) return Promise.resolve(first.subarray(offset - start, offset - start + length))

			const out = new Uint8Array(length)

			for (let at = 0; at < length; index++) {
				const chunk = chunks[index]

				if (chunk === undefined) break

				const from = offset + at - (starts[index] ?? 0)
				const take = Math.min(chunk.length - from, length - at)

				out.set(chunk.subarray(from, from + take), at)
				at += take
			}

			return Promise.resolve(out)
		}
	}
}

export function memorySink(): MemorySink {
	const chunks: Uint8Array[] = []
	let total = 0

	return {
		write(chunk: Uint8Array): Promise<void> {
			chunks.push(chunk)
			total += chunk.length

			return Promise.resolve()
		},
		close(): Promise<void> {
			return Promise.resolve()
		},
		chunks: () => chunks,
		bytes(): Uint8Array {
			if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0]

			const out = new Uint8Array(total)
			let offset = 0

			for (const chunk of chunks) {
				out.set(chunk, offset)
				offset += chunk.length
			}

			chunks.length = 0
			chunks.push(out)

			return out
		}
	}
}
