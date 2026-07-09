import * as Comlink from "comlink"
import { Semaphore } from "@filen/utils"
import type { File as SdkFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { readThumbnailBlob, deleteThumbnail as deleteThumbnailBlob } from "@/lib/drive/thumb-cache"
import { thumbnailCategory, THUMB_MAX_DIM, type ThumbnailCategory } from "@/lib/drive/thumbnails.logic"
import { type BaseFileItem, type DriveItem } from "@/lib/drive/item"

// makeThumbnailInMemory always encodes to webp (MakeThumbnailInMemoryResult.webpData); a client-side
// generator is expected to match that on-disk format too, so every rendered thumbnail blob uses the
// same mime regardless of which category produced its bytes.
const THUMB_MIME = "image/webp"

// How many generation attempts (OPFS read + SDK call/generator) run at once, app-wide — shapes
// DEMAND on the SDK/CPU, never a limit the SDK itself needs (D21: never reimplement SDK-side
// concurrency; this bounds how many requests THIS app issues concurrently).
const CONCURRENT_GENERATIONS = 3

// Permanent-failure threshold — the third failed generation for a uuid blacklists it for the rest of
// the session, short-circuiting every later call instead of repeating pointless work (a corrupt
// file, an SDK decode refusal, or — until generators are registered — an unimplemented category).
const BLACKLIST_LIMIT = 3

// heic/video/pdf only — sdk-image always routes to makeThumbnailInMemory and never consults this
// registry.
export type ThumbGeneratorCategory = Exclude<ThumbnailCategory, "sdk-image" | "none">
export type ThumbGenerator = (item: BaseFileItem) => Promise<Uint8Array | null>

const generators = new Map<ThumbGeneratorCategory, ThumbGenerator>()

// Registration seam for the client-side generators: an unregistered category resolves no bytes,
// exactly like any other generation failure (see generate() below) — there is nothing category-
// specific for a caller to branch on once one is registered.
export function registerThumbGenerator(category: ThumbGeneratorCategory, generator: ThumbGenerator): void {
	generators.set(category, generator)
}

// Injected collaborators so the service is unit-testable without a worker, OPFS, or a real Blob-URL
// registry — mirrors RunUploadDeps (lib/drive/upload.ts).
export interface ThumbnailServiceDeps {
	readThumbnailBlob: (uuid: string) => Promise<Blob | null>
	deleteThumbnail: (uuid: string) => Promise<void>
	makeThumbnail: (file: SdkFile, maxDim: number) => Promise<Uint8Array | undefined>
	storeThumbnail: (uuid: string, bytes: Uint8Array) => Promise<void>
	createObjectUrl: (blob: Blob) => string
	revokeObjectUrl: (url: string) => void
	getGenerator: (category: ThumbGeneratorCategory) => ThumbGenerator | undefined
}

// The real wiring: readThumbnailBlob/deleteThumbnail go straight to the main-thread OPFS read side
// (no worker round trip — see thumb-cache.ts), makeThumbnail/storeThumbnail cross to the sdk worker.
// storeThumbnail Comlink.transfers its buffer in, mirroring preview-save.logic.ts's uploadFileBytes.
export const defaultThumbnailDeps: ThumbnailServiceDeps = {
	readThumbnailBlob,
	deleteThumbnail: deleteThumbnailBlob,
	makeThumbnail: (file, maxDim) => sdkApi.makeThumbnail(file, maxDim),
	storeThumbnail: (uuid, bytes) => sdkApi.storeThumbnail(uuid, Comlink.transfer(bytes, [bytes.buffer])),
	createObjectUrl: blob => URL.createObjectURL(blob),
	revokeObjectUrl: url => {
		URL.revokeObjectURL(url)
	},
	getGenerator: category => generators.get(category)
}

// uuid -> live objectURL for a rendered thumbnail. Module-level for the tab's whole lifetime — every
// entry is only ever dropped by invalidateThumbnail (uuid rotation, or a caller giving up on a torn
// render), never by a timer.
const urls = new Map<string, string>()
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
// by category — sdk-image through the SDK worker, everything else through the registered generator
// (an unregistered category resolves no bytes, same as any other failure below). A persisted
// client-generated result is written back through storeThumbnail — a persist failure there is
// logged and non-fatal, mirroring the worker's own makeThumbnail persist. Any failure to obtain
// bytes — a thrown error, `undefined`, an empty buffer, or no generator — is LOGGED ONLY (never
// surfaced to a user: thumbnail generation is silent by design) and counted against the blacklist.
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
		let needsPersist = false

		try {
			if (category === "sdk-image") {
				// The worker's own makeThumbnail op already persisted this (writeThumb, before it ever
				// transfers the buffer back out) — nothing left for this thread to store.
				bytes = await runOp(deps.makeThumbnail(item.data, THUMB_MAX_DIM))
			} else {
				const generator = deps.getGenerator(category)
				const generated = generator === undefined ? null : await generator(item)

				if (generated !== null) {
					bytes = generated
					needsPersist = true
				}
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
		// bytes here is always backed by a real ArrayBuffer (a Comlink.transfer out of the sdk worker, or
		// a generator's own freshly-allocated buffer, never a SharedArrayBuffer), so this narrows the
		// generic parameter only, mirroring image-viewer.tsx's identical cast. Built BEFORE the persist
		// call below: the Blob constructor copies bytes into its own storage immediately, whereas
		// storeThumbnail's Comlink.transfer detaches this SAME buffer synchronously, at the call itself
		// (postMessage's transfer-list handoff, not once the call resolves) — persisting first would
		// leave `bytes` a zero-length view by the time this line ran, silently producing an empty Blob.
		const attachedBytes = bytes as Uint8Array<ArrayBuffer>
		const blob = new Blob([attachedBytes], { type: THUMB_MIME })

		if (needsPersist) {
			await deps.storeThumbnail(uuid, attachedBytes).catch((e: unknown) => {
				log.warn("thumbnails", "generate: persist failed", uuid, e)
			})
		}

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
