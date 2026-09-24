import { PREVIEW_MAX_BYTES } from "@/features/drive/lib/preview.logic"
import { type RawPreviewResult } from "@/features/preview/lib/rawPreview.logic"

// What a preview already loaded this session, so stepping back to a pager slot (or saving a public file
// that is showing inline) does not fetch it again. Memory only, never persisted. Keys carry the access
// scope and the item uuid: a content change rotates the uuid, so a stale entry is never read again, it
// just ages out. Nothing here owns an object URL — viewers mint and revoke their own — so evicting an
// entry only drops the reference.

// The current slot plus a neighbour either side for back-and-forth stepping.
const MAX_ENTRIES = 4
// The largest buffer a preview may load, so any single previewable file fits but two max-size files
// are never held at once.
const MAX_BYTES = Number(PREVIEW_MAX_BYTES)
// Ids name registrations the service worker already bounds on its own, and cost nothing here.
const MAX_STREAM_IDS = 16

interface Entry<T> {
	value: T
	size: number
}

// Least recently used first: Map iteration is insertion order and every read re-inserts.
class BoundedLru<T> {
	private readonly entries = new Map<string, Entry<T>>()
	private readonly maxEntries: number
	private readonly maxBytes: number
	private total = 0

	public constructor(maxEntries: number, maxBytes: number) {
		this.maxEntries = maxEntries
		this.maxBytes = maxBytes
	}

	public get(key: string): Entry<T> | undefined {
		const entry = this.entries.get(key)

		if (entry !== undefined) {
			this.entries.delete(key)
			this.entries.set(key, entry)
		}

		return entry
	}

	public set(key: string, value: T, size: number): void {
		this.delete(key)

		if (size > this.maxBytes) {
			return
		}

		this.entries.set(key, { value, size })
		this.total += size
		this.evictUntil(0)
	}

	// Frees room for a load about to land, so what is held here plus the one buffer in flight stays
	// within the budget instead of briefly doubling it.
	public reserve(size: number): void {
		this.evictUntil(size)
	}

	public delete(key: string): void {
		const entry = this.entries.get(key)

		if (entry !== undefined) {
			this.entries.delete(key)
			this.total -= entry.size
		}
	}

	public clear(): void {
		this.entries.clear()
		this.total = 0
	}

	private evictUntil(incoming: number): void {
		for (const key of this.entries.keys()) {
			if (this.entries.size <= this.maxEntries && this.total + incoming <= this.maxBytes) {
				return
			}

			this.delete(key)
		}
	}
}

// One budget for both kinds: a RAW's embedded JPEG is small, but it is still memory.
const loaded = new BoundedLru<Uint8Array | RawPreviewResult>(MAX_ENTRIES, MAX_BYTES)
const streamIds = new BoundedLru<string>(MAX_STREAM_IDS, 0)
// Bumped by every clear, so a load that started before it cannot repopulate the cache after it.
let epoch = 0

export function previewCacheEpoch(): number {
	return epoch
}

// `scope` is previewCacheScope's (accessMode.tsx); null caches nothing.
export function getPreviewBytes(scope: string | null, uuid: string): Uint8Array | undefined {
	if (scope === null) {
		return undefined
	}

	const key = `bytes:${scope}:${uuid}`
	const entry = loaded.get(key)

	// A consumer that transferred the buffer to a worker would leave an empty view behind.
	if (entry === undefined || !(entry.value instanceof Uint8Array) || entry.value.byteLength !== entry.size) {
		loaded.delete(key)

		return undefined
	}

	return entry.value
}

// One whole-buffer load per key at a time, started by a preview and joined by another preview or a
// public Download. Removed when it settles, so a failure never outlives the attempt that made it.
const pendingBytes = new Map<string, Promise<Uint8Array>>()

// The bytes of `uuid` if they are cached or already loading, else undefined. A shared load that fails
// or is cancelled (its owner, the preview, went away) also answers undefined, leaving the caller to
// fetch on its own: a preview's cancellation never fails a Download that joined it.
export async function joinPreviewBytes(scope: string | null, uuid: string): Promise<Uint8Array | undefined> {
	const cached = getPreviewBytes(scope, uuid)

	if (cached !== undefined || scope === null) {
		return cached
	}

	return await pendingBytes.get(`bytes:${scope}:${uuid}`)?.catch(() => undefined)
}

// What a caller that went away gets instead of a load of its own: asErrorDTO reads the name as the
// Cancelled kind.
function cancelledError(): Error {
	const error = new Error("Cancelled")

	error.name = "Cancelled"

	return error
}

// The cached or in-flight bytes of `uuid`, else `load`'s, shared with any caller that joins while it
// runs and stored once it succeeds. Everything up to registering the load runs synchronously, so two
// callers in the same tick still share one fetch. `size` makes room before the buffer lands. Once
// `signal` aborts, the caller starts no load: its cancel token only reaches a download it started, so
// one begun after it went away could never be cancelled.
export function loadPreviewBytes(
	scope: string | null,
	uuid: string,
	size: number,
	load: () => Promise<Uint8Array>,
	signal?: AbortSignal
): Promise<Uint8Array> {
	if (signal?.aborted === true) {
		return Promise.reject(cancelledError())
	}

	const cached = getPreviewBytes(scope, uuid)

	if (cached !== undefined) {
		return Promise.resolve(cached)
	}

	if (scope === null) {
		return load()
	}

	const key = `bytes:${scope}:${uuid}`
	const pending = pendingBytes.get(key)

	if (pending !== undefined) {
		// The owner's failure (or cancellation) is not this caller's: retry with its own fetch, which the
		// next joiner shares in turn. The retry checks `signal` again, since the caller may have gone
		// away while it waited.
		return pending.catch(() => {
			if (pendingBytes.get(key) === pending) {
				pendingBytes.delete(key)
			}

			return loadPreviewBytes(scope, uuid, size, load, signal)
		})
	}

	const loadEpoch = epoch

	loaded.reserve(size)

	const own = load().then(bytes => {
		if (loadEpoch === epoch) {
			loaded.set(key, bytes, bytes.byteLength)
		}

		return bytes
	})
	const settle = (): void => {
		if (pendingBytes.get(key) === own) {
			pendingBytes.delete(key)
		}
	}

	pendingBytes.set(key, own)
	own.then(settle, settle)

	return own
}

// Makes room for a buffer about to be held outside the cache (a public Download's own fetch), so the
// two together stay within the budget, as a preview's load does.
export function reservePreviewRoom(size: number): void {
	loaded.reserve(size)
}

export function getRawPreview(scope: string | null, uuid: string): RawPreviewResult | undefined {
	if (scope === null) {
		return undefined
	}

	const value = loaded.get(`raw:${scope}:${uuid}`)?.value

	return value === undefined || value instanceof Uint8Array ? undefined : value
}

export function setRawPreview(scope: string | null, uuid: string, preview: RawPreviewResult, loadEpoch: number): void {
	if (scope !== null && loadEpoch === epoch) {
		loaded.set(`raw:${scope}:${uuid}`, preview, preview.type === "preview" ? preview.blob.size : 0)
	}
}

export function getPreviewStreamId(scope: string | null, uuid: string, contentType: string): string | undefined {
	return scope === null ? undefined : streamIds.get(`${scope}:${uuid}:${contentType}`)?.value
}

export function setPreviewStreamId(scope: string | null, uuid: string, contentType: string, id: string, loadEpoch: number): void {
	if (scope !== null && loadEpoch === epoch) {
		streamIds.set(`${scope}:${uuid}:${contentType}`, id, 0)
	}
}

export function forgetPreviewStreamId(scope: string | null, uuid: string, contentType: string): void {
	if (scope !== null) {
		streamIds.delete(`${scope}:${uuid}:${contentType}`)
	}
}

// On overlay close, on leaving a public link and on logout.
export function clearPreviewCache(): void {
	epoch++
	loaded.clear()
	pendingBytes.clear()
	streamIds.clear()
}
