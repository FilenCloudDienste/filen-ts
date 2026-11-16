import { originKey, originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { loadPreviewBytes } from "@/features/preview/lib/previewCache"

export interface LoadOriginBytesOptions {
	// The surface asking (usePreviewAccessMode): a public link's reads only what needs no session.
	readonly access: OriginAccess
	// The most the origin may be; a larger one is refused before anything is read.
	readonly cap: number
	// Kept in the preview cache once loaded (default). False shares a load under way without keeping its result.
	readonly store?: boolean
	readonly signal?: AbortSignal
	// The preview cache's scope (previewCacheScope); null or unset caches nothing.
	readonly scope?: string | null
}

// An origin's whole bytes through the preview cache, keyed by originKey, under `token`. An archive entry is decoded
// whole with its checksum verified. A `bytes` origin is read from its Blob and never cached: its holder has it.
export async function loadOriginBytes(origin: ByteOrigin, token: string, options: LoadOriginBytesOptions): Promise<Uint8Array> {
	const size = originSize(origin)
	const { cap, signal } = options

	signal?.throwIfAborted()

	if (size > cap) {
		throw new Error(`${String(size)} bytes is above the cap of ${String(cap)}`)
	}

	if (origin.kind === "bytes") {
		const bytes = new Uint8Array(await origin.blob.arrayBuffer())

		signal?.throwIfAborted()

		return bytes
	}

	return await loadPreviewBytes(
		options.scope ?? null,
		originKey(origin),
		size,
		() => runOp(sdkApi.downloadOriginBytes(origin, options.access, cap, token)),
		{
			...(signal === undefined ? {} : { signal }),
			store: options.store ?? true
		}
	)
}
