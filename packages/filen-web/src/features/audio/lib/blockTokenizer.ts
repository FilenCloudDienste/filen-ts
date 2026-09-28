import { AbstractTokenizer, EndOfStreamError, type IReadChunkOptions } from "strtok3"

// Random-access reads over a remote file, in whole blocks. The SDK downloads and decrypts a file chunk
// by chunk (1 MiB), so asking for an aligned chunk costs the same transfer as asking for three bytes of
// it; reading in chunk-sized blocks and keeping the last few turns a parser's many tiny reads (a tag
// header, a trailer probe, the atoms of an MP4 `moov`) into one download per distinct chunk.
export const BLOCK_BYTES = 1_048_576

// Resident blocks per parse. The usual working set is the head block and the tail block (every parse
// probes the file's end for ID3v1/APE trailers), plus one for a tag or cover crossing a boundary.
const CACHED_BLOCKS = 3

// Block downloads one parse may make. Covers a head tag with a multi-megabyte cover plus the
// tail; past it the parser is walking the file's body, which is never worth doing for tags.
export const MAX_BLOCK_READS = 8

// A block download failed. The parse is abandoned but nothing is concluded about the file.
export class BlockReadError extends Error {
	public constructor(cause: unknown) {
		super("audio block read failed", { cause })
		this.name = "BlockReadError"
	}
}

// The parse asked for more of the file than tags ever need. A property of the file, not of the read.
export class ReadBudgetError extends Error {
	public constructor() {
		super("audio metadata read budget exhausted")
		this.name = "ReadBudgetError"
	}
}

// `end` is exclusive.
export type ReadRange = (start: number, end: number) => Promise<Uint8Array>

// The block cache and budget one file's parse shares, possibly across more than one tokenizer (a
// content sniff that falls back to a mime hint re-reads the same blocks for free). `readError` keeps the
// first failed download even when a parser swallows the throw and resolves partial tags.
export class BlockSource {
	public readonly size: number
	public readError: BlockReadError | null = null
	private readonly readRange: ReadRange
	private readonly blocks = new Map<number, Promise<Uint8Array>>()
	private blockReads = 0

	public constructor(size: number, readRange: ReadRange) {
		this.size = size
		this.readRange = readRange
	}

	private block(index: number): Promise<Uint8Array> {
		const cached = this.blocks.get(index)

		if (cached !== undefined) {
			// Re-inserted so the Map's insertion order stays least-recently-used first.
			this.blocks.delete(index)
			this.blocks.set(index, cached)

			return cached
		}

		if (this.blockReads >= MAX_BLOCK_READS) {
			return Promise.reject(new ReadBudgetError())
		}

		this.blockReads++

		const start = index * BLOCK_BYTES
		const end = Math.min(this.size, start + BLOCK_BYTES)
		// A failed download stays cached as the rejection: the SDK has already retried it, so a parser that
		// swallows the throw and reads the block again fails fast instead of downloading it again.
		const guarded = this.readRange(start, end)
			.then(bytes => {
				if (bytes.length !== end - start) {
					throw new Error(`short block read: ${String(bytes.length)} of ${String(end - start)} bytes`)
				}

				return bytes
			})
			.catch((error: unknown) => {
				const readError = new BlockReadError(error)

				this.readError ??= readError

				throw readError
			})

		this.blocks.set(index, guarded)

		while (this.blocks.size > CACHED_BLOCKS) {
			const oldest = this.blocks.keys().next()

			if (oldest.done === true) {
				break
			}

			this.blocks.delete(oldest.value)
		}

		return guarded
	}

	// Fills `target[0, length)` from the file at `position`; the range must lie inside the file.
	public async read(target: Uint8Array, position: number, length: number): Promise<void> {
		let written = 0

		while (written < length) {
			const at = position + written
			const index = Math.floor(at / BLOCK_BYTES)
			const block = await this.block(index)
			const offset = at - index * BLOCK_BYTES
			const take = Math.min(length - written, block.length - offset)

			target.set(block.subarray(offset, offset + take), written)
			written += take
		}
	}
}

// strtok3's random-access contract over a BlockSource, mirroring its own BlobTokenizer: the same
// read/peek split, the same EndOfStreamError on a short read without `mayBeLess`.
export class BlockTokenizer extends AbstractTokenizer {
	public readonly fileInfo: { size: number; mimeType?: string }
	private readonly source: BlockSource

	public constructor(source: BlockSource, mimeType?: string) {
		super()

		this.source = source
		this.fileInfo = mimeType !== undefined ? { size: source.size, mimeType } : { size: source.size }
	}

	public supportsRandomAccess(): boolean {
		return true
	}

	public setPosition(position: number): void {
		this.position = position
	}

	public async readBuffer(uint8Array: Uint8Array, options?: IReadChunkOptions): Promise<number> {
		if (options?.position !== undefined) {
			this.position = options.position
		}

		const bytesRead = await this.peekBuffer(uint8Array, { ...options, position: this.position })

		this.position += bytesRead

		return bytesRead
	}

	public async peekBuffer(uint8Array: Uint8Array, options?: IReadChunkOptions): Promise<number> {
		const normalized = this.normalizeOptions(uint8Array, options)
		const bytesAvailable = Math.max(0, this.source.size - normalized.position)
		const bytesToRead = Math.min(bytesAvailable, normalized.length)

		if (!normalized.mayBeLess && bytesToRead < normalized.length) {
			throw new EndOfStreamError()
		}

		if (bytesToRead <= 0) {
			return 0
		}

		await this.source.read(uint8Array, normalized.position, bytesToRead)

		return bytesToRead
	}
}
