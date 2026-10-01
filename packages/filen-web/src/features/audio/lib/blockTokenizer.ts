import { AbstractTokenizer, EndOfStreamError, type IReadChunkOptions } from "strtok3"
import type { BlockSource } from "@/lib/media/blockSource"

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
