import * as Comlink from "comlink"
import { Semaphore } from "@filen/utils"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { readThumbnailBlob, deleteThumbnail as deleteThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { thumbnailCategory, type ThumbnailCategory } from "@/features/drive/lib/thumbnails.logic"
import { type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { createThumbnailUrlCache, computeThumbnailCapacity } from "@/features/drive/lib/thumbnailUrlCache"

// No declared mime on rendered thumbnail blobs: a generator's canvas encode is webp where the browser
// supports it and legally falls back to jpeg where it doesn't — a hardcoded label would lie for those
// bytes, and the OPFS cache-hit path (a raw File for a .thumb extension) carries no reliable type
// either. <img> sources are content-sniffed regardless, so untyped is the one consistent, honest
// option for every path.

// How many generation attempts (OPFS read + generator) run at once, app-wide — shapes DEMAND on the
// CPU/SDK-download layer, never a limit the SDK itself needs (never reimplement SDK-side
// concurrency; this bounds how many requests THIS app issues concurrently).
const CONCURRENT_GENERATIONS = 3

// Permanent-failure threshold — the third failed generation for a uuid blacklists it for the rest of
// the session, short-circuiting every later call instead of repeating pointless work (a corrupt or
// undecodable file, or — until generators are registered — an unimplemented category).
const BLACKLIST_LIMIT = 3

// Every non-"none" category routes through the generator registry — image/heic/video/pdf alike. There
// is no longer a special SDK-decoded arm; a plain raster image is just another registered generator
// (thumbGenerators.ts's generateImageThumb, a client-side createImageBitmap decode).
export type ThumbGeneratorCategory = Exclude<ThumbnailCategory, "none">
export type ThumbGenerator = (item: BaseFileItem) => Promise<Uint8Array | null>

const generators = new Map<ThumbGeneratorCategory, ThumbGenerator>()

// Registration seam for the client-side generators: an unregistered category resolves no bytes,
// exactly like any other generation failure (see generate() below) — there is nothing category-
// specific for a caller to branch on once one is registered.
export function registerThumbGenerator(category: ThumbGeneratorCategory, generator: ThumbGenerator): void {
	generators.set(category, generator)
}

// Injected collaborators so the service is unit-testable without a worker, OPFS, or a real Blob-URL
// registry — mirrors RunUploadDeps (features/drive/lib/upload.ts).
export interface ThumbnailServiceDeps {
	readThumbnailBlob: (uuid: string) => Promise<Blob | null>
	deleteThumbnail: (uuid: string) => Promise<void>
	storeThumbnail: (uuid: string, bytes: Uint8Array) => Promise<void>
	createObjectUrl: (blob: Blob) => string
	revokeObjectUrl: (url: string) => void
	getGenerator: (category: ThumbGeneratorCategory) => ThumbGenerator | undefined
}

// The real wiring: readThumbnailBlob/deleteThumbnail go straight to the main-thread OPFS read side
// (no worker round trip — see thumbCache.ts), storeThumbnail crosses to the sdk worker (which owns
// writeThumb and arms the once-per-session cache sweep there). storeThumbnail Comlink.transfers its
// buffer in, mirroring previewSave.logic.ts's uploadFileBytes.
export const defaultThumbnailDeps: ThumbnailServiceDeps = {
	readThumbnailBlob,
	deleteThumbnail: deleteThumbnailBlob,
	storeThumbnail: (uuid, bytes) => sdkApi.storeThumbnail(uuid, Comlink.transfer(bytes, [bytes.buffer])),
	createObjectUrl: blob => URL.createObjectURL(blob),
	revokeObjectUrl: url => {
		URL.revokeObjectURL(url)
	},
	getGenerator: category => generators.get(category)
}

// uuid -> live objectURL for a rendered thumbnail. Module-level for the tab's whole lifetime, bounded
// to a viewport-derived LRU capacity (see thumbnailUrlCache.ts) — every entry is dropped either by
// invalidateThumbnail (uuid rotation, or a caller giving up on a torn render) or by the LRU itself once
// capacity is exceeded, never by a timer. Eviction always revokes through defaultThumbnailDeps: the
// real objectURL registry is a single browser-global resource regardless of which deps a particular
// caller injected to CREATE the url (tests inject fakes for that; production only ever uses
// defaultThumbnailDeps, so this is the one wiring that matters at runtime).
const urls = createThumbnailUrlCache(computeThumbnailCapacity(0, 0, "list"), (_uuid, url) => {
	defaultThumbnailDeps.revokeObjectUrl(url)
})
// uuid -> accumulated failure count, capped by BLACKLIST_LIMIT — see generate()'s own failure path.
const failures = new Map<string, number>()
// uuid -> the in-flight generation attempt, so two concurrent callers for the same uuid share one
// generation instead of each starting their own.
const pending = new Map<string, Promise<string | null>>()

const semaphore = new Semaphore(CONCURRENT_GENERATIONS)

function finalize(deps: ThumbnailServiceDeps, uuid: string, blob: Blob): string {
	const url = deps.createObjectUrl(blob)
	urls.set(uuid, url)
	return url
}

// The one real generation attempt for a uuid, gated by the app-wide semaphore: check the OPFS cache
// first (another tab, or an earlier session, may have already produced this thumbnail), then route
// through the registered generator for the category (an unregistered category resolves no bytes, same
// as any other failure below). A generated result is written back through storeThumbnail — a persist
// failure there is logged and non-fatal. Any failure to obtain bytes — a thrown error, an empty
// buffer, or no generator — is LOGGED ONLY (never surfaced to a user: thumbnail generation is silent
// by design) and counted against the blacklist.
async function generate(
	deps: ThumbnailServiceDeps,
	item: BaseFileItem,
	category: Exclude<ThumbnailCategory, "none">,
	uuid: string
): Promise<string | null> {
	await semaphore.acquire()

	try {
		// A read failure beyond the clean miss (readThumbnailBlob only maps NotFoundError to null —
		// e.g. a quota/permission DOMException, or an eviction sweep racing this read) must degrade to
		// the ordinary generate path, NOT reject out of the shared pending promise: a rejection would
		// break the never-throws contract for every caller joined on this uuid AND skip the failure
		// counter below, bypassing the blacklist into a retry-forever loop.
		let cached: Blob | null = null
		try {
			cached = await deps.readThumbnailBlob(uuid)
		} catch (e) {
			log.warn("thumbnails", "generate: cache read failed", uuid, e)
		}

		if (cached !== null) {
			return finalize(deps, uuid, cached)
		}

		let bytes: Uint8Array | undefined

		try {
			const generator = deps.getGenerator(category)
			const generated = generator === undefined ? null : await generator(item)

			if (generated !== null) {
				bytes = generated
			}
		} catch (e) {
			log.warn("thumbnails", "generate: generation failed", uuid, e)
		}

		if (bytes === undefined || bytes.length === 0) {
			failures.set(uuid, (failures.get(uuid) ?? 0) + 1)
			return null
		}

		// The generic ArrayBufferLike-vs-ArrayBuffer parameter on Uint8Array (TS lib.es2024.arraybuffer)
		// makes an unparameterized Uint8Array reject BlobPart's stricter ArrayBufferView<ArrayBuffer> —
		// bytes here is always backed by a real ArrayBuffer (a generator's own freshly-allocated buffer,
		// never a SharedArrayBuffer), so this narrows the generic parameter only, mirroring
		// imageViewer.tsx's identical cast. Built BEFORE the persist call below: the Blob constructor
		// copies bytes into its own storage immediately, whereas storeThumbnail's Comlink.transfer
		// detaches this SAME buffer synchronously, at the call itself (postMessage's transfer-list
		// handoff, not once the call resolves) — persisting first would leave `bytes` a zero-length view
		// by the time this line ran, silently producing an empty Blob.
		const attachedBytes = bytes as Uint8Array<ArrayBuffer>
		const blob = new Blob([attachedBytes])

		await deps.storeThumbnail(uuid, attachedBytes).catch((e: unknown) => {
			log.warn("thumbnails", "generate: persist failed", uuid, e)
		})

		return finalize(deps, uuid, blob)
	} finally {
		semaphore.release()
	}
}

// The service's one read entry point. Routing order: no category -> null; a live objectURL -> reuse
// it; blacklisted -> null without touching the cache/semaphore again; an in-flight generation for
// this uuid -> join it; otherwise start a fresh, semaphore-gated generation. `deps` defaults to the
// real worker/OPFS/Blob-URL wiring — pass a fake for tests.
export async function getThumbnailUrl(item: DriveItem, deps: ThumbnailServiceDeps = defaultThumbnailDeps): Promise<string | null> {
	const category = thumbnailCategory(item)

	if (category === "none" || item.type !== "file") {
		// Unreachable in practice — thumbnailCategory already returns "none" for every non-file arm —
		// kept so the file-arm access below (item.data as an SDK File) type-checks without a non-null
		// assertion.
		return null
	}

	const uuid = item.data.uuid
	const cachedUrl = urls.get(uuid)

	if (cachedUrl !== undefined) {
		return cachedUrl
	}

	if ((failures.get(uuid) ?? 0) >= BLACKLIST_LIMIT) {
		return null
	}

	const inFlight = pending.get(uuid)

	if (inFlight !== undefined) {
		return inFlight
	}

	const attempt = generate(deps, item, category, uuid).finally(() => {
		pending.delete(uuid)
	})

	pending.set(uuid, attempt)

	return attempt
}

// Drops a uuid's rendered thumbnail (revoking its objectURL) and its on-disk cache entry, then
// clears exactly one blacklist strike — a uuid rotation or a torn write deserves one fresh attempt,
// not an automatic full reset of an otherwise-legitimate run of failures. `deps` defaults to the
// real wiring; pass a fake for tests. Never throws: the delete is fire-and-forget, logged on failure
// only (mirrors the thumbnail-silence rule generate() itself follows).
export function invalidateThumbnail(uuid: string, deps: ThumbnailServiceDeps = defaultThumbnailDeps): void {
	const url = urls.get(uuid)

	if (url !== undefined) {
		deps.revokeObjectUrl(url)
		urls.delete(uuid)
	}

	void deps.deleteThumbnail(uuid).catch((e: unknown) => {
		log.warn("thumbnails", "invalidateThumbnail: delete failed", uuid, e)
	})

	const count = failures.get(uuid)

	if (count !== undefined) {
		if (count <= 1) {
			failures.delete(uuid)
		} else {
			failures.set(uuid, count - 1)
		}
	}
}

// Resizes the bounded objectURL cache to whatever the current listing viewport can actually show —
// called from useDriveVirtualizer's own ResizeObserver effect (that observer already fires on every
// layout change that matters here: OS window resize, sidebar collapse, view-mode toggle), so there is
// no separate window-resize listener in this module. Shrinking capacity evicts down to the new size
// immediately, via the same LRU order get()/set() maintain everywhere else.
export function setThumbnailViewport(viewportWidth: number, viewportHeight: number, viewMode: DriveViewMode): void {
	urls.setCapacity(computeThumbnailCapacity(viewportWidth, viewportHeight, viewMode))
}
