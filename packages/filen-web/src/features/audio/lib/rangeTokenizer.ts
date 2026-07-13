import { AbstractTokenizer, EndOfStreamError, type IReadChunkOptions, type ITokenizerOptions } from "strtok3"

// A minimal strtok3 random-access tokenizer over the SW's Range/206-capable inline stream route. This
// is what lets music-metadata read tags without ever downloading a whole file: instead of handing the
// parser a Blob or an in-memory buffer, it hands it THIS, and every `readBuffer`/`peekBuffer` call the
// parser makes turns into a `fetch(url, {headers:{Range}})` for exactly the byte window it asked for —
// an ID3v2 header up front, an ID3v1/APEv2 trailer, or (the case that actually matters) M4A `moov`/FLAC
// metadata wherever the encoder placed it, all without pulling the bytes in between. Mirrors strtok3's
// own BlobTokenizer (same read/peek split over `normalizeOptions`, the same EndOfStreamError contract)
// with a ranged HTTP fetch standing in for `Blob.slice`. This file is only ever reached through a
// dynamic `import()` from metadata.ts, so it (and the small `strtok3` runtime it pulls in) never lands
// in the app's main bundle.
export class RangeFetchTokenizer extends AbstractTokenizer {
	public readonly fileInfo: { size: number; mimeType?: string }
	private readonly url: string
	private readonly fetchImpl: typeof fetch

	public constructor(
		url: string,
		size: number,
		mimeType: string | undefined,
		fetchImpl: typeof fetch = fetch,
		options?: ITokenizerOptions
	) {
		super(options)

		this.url = url
		this.fileInfo = mimeType !== undefined ? { size, mimeType } : { size }
		this.fetchImpl = fetchImpl
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
		const bytesAvailable = Math.max(0, this.fileInfo.size - normalized.position)
		const bytesToRead = Math.min(bytesAvailable, normalized.length)

		// Known EOF from the file's own size (mirrors strtok3's BlobTokenizer: compare the
		// availability-clamped amount against what was actually REQUESTED, not against itself) — caught
		// before ever issuing a fetch.
		if (!normalized.mayBeLess && bytesToRead < normalized.length) {
			throw new EndOfStreamError()
		}

		if (bytesToRead <= 0) {
			return 0
		}

		const rangeEnd = normalized.position + bytesToRead - 1
		const response = await this.fetchImpl(this.url, {
			headers: { Range: `bytes=${String(normalized.position)}-${String(rangeEnd)}` }
		})

		if (!response.ok) {
			throw new Error(`audio metadata range request failed with status ${String(response.status)}`)
		}

		const chunk = new Uint8Array(await response.arrayBuffer())
		const readable = Math.min(chunk.length, bytesToRead)

		uint8Array.set(chunk.subarray(0, readable))

		// A genuinely short network response (fewer bytes than the already-satisfiable window promised) —
		// distinct from the known-EOF case above, which is caught before any fetch happens.
		if (readable < bytesToRead && !normalized.mayBeLess) {
			throw new EndOfStreamError()
		}

		return readable
	}
}
