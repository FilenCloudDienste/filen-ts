import * as Comlink from "comlink"
import { onlineManager } from "@tanstack/react-query"
import { Semaphore, InFlight } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { readThumbnailBlob, deleteThumbnail as deleteThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { thumbnailCategory, type ThumbnailCategory } from "@/features/drive/lib/thumbnails.logic"
import { asDirectoryOrFile, type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { createThumbnailUrlCache, computeThumbnailCapacity } from "@/features/drive/lib/thumbnailUrlCache"

// No declared mime on rendered thumbnail blobs: the format genuinely varies by producer. The SDK arm
// always encodes webp in wasm, while the video/pdf canvas encodes are webp where the browser supports
// it and legally fall back to jpeg where it doesn't — so a hardcoded label would lie for some of these
// bytes, and the OPFS cache-hit path (a raw File for a .thumb extension) carries no reliable type
// either. <img> sources are content-sniffed regardless, so untyped is the one consistent, honest
// option for every path.

// How many generation attempts (OPFS read + generator) run at once, app-wide — shapes DEMAND on the
// CPU/SDK-download layer, never a limit the SDK itself needs (never reimplement SDK-side
// concurrency; this bounds how many requests THIS app issues concurrently).
const CONCURRENT_GENERATIONS = 3

// Permanent-failure threshold — the third failed generation for a uuid blacklists it for the rest of
// the session, short-circuiting every later call instead of repeating pointless work (a download that
// keeps failing, a decode worker that keeps dying, or — until generators are registered — an
// unimplemented category). A SETTLED verdict is NOT one of these; see `unavailable` below.
const BLACKLIST_LIMIT = 3

// Every non-"none" category routes through the generator registry — sdk/video/pdf alike. The service
// itself stays producer-agnostic: whether a category's bytes come out of the Rust SDK or a browser
// decode is entirely the registered generator's business.
export type ThumbGeneratorCategory = Exclude<ThumbnailCategory, "none">

// A generator's answer, three-way rather than the old `Uint8Array | null`. The distinction that
// matters is between "failed" (transient — a dropped download, a dead worker; worth retrying, counts
// toward the blacklist) and "unavailable" (SETTLED — the producer has looked at this file's CONTENT
// and answered definitively; retrying cannot change it, so it is remembered for the session and costs
// no blacklist strike). Collapsing the two, as the old null did, made three undecodable RAW files
// indistinguishable from three flaky downloads.
export type ThumbGenerationResult =
	{ type: "bytes"; bytes: Uint8Array } | { type: "unavailable"; reason: "unsupported" | "overBudget" | "corrupt" } | { type: "failed" }

export type ThumbGenerator = (item: BaseFileItem) => Promise<ThumbGenerationResult>

// What a seeded production answers (see seedThumbnail). Three-way for the reason ThumbGenerationResult
// is, but the line falls elsewhere: "none" is a verdict about the FILE — the production read the local
// bytes and there is no thumbnail in them, which the ordinary producer would conclude from the same
// bytes. "unanswered" is the production declining, either by throwing or by refusing on a limit of its
// own READING STRATEGY rather than of the file, which tells the seat nothing about what the ordinary
// producer would manage on the same uuid.
export type ThumbSeedResult = { type: "bytes"; bytes: Uint8Array } | { type: "none" } | { type: "unanswered" }

const generators = new Map<ThumbGeneratorCategory, ThumbGenerator>()

// Registration seam for the generators: an unregistered category resolves no bytes, exactly like any
// other transient generation failure (see generate() below) — there is nothing category-specific for
// a caller to branch on once one is registered.
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
// uuids a generator has returned a SETTLED verdict for during THIS session (no decoder for the
// format, past the producer's decode budget, damaged bytes). Deliberately never persisted: the
// verdict belongs to the producer that gave it, and the next SDK version may well decode what this
// one refused, so it must not outlive the tab. Membership costs no blacklist strike — a definite
// answer is not a failure, and mixing the two would let a handful of undecodable files burn a retry
// budget that exists for flaky ones.
const unavailable = new Set<string>()

// An offline -> online transition clears every settled verdict. Query's onlineManager only notifies
// its listeners when the value actually changes, so `online === true` here IS that transition, never
// a repeat of a state already held. The reason to clear: a verdict reached while the tab was offline
// was reached under a degraded read path, and coming back online is the one cheap, obvious moment to
// give every item a fresh chance rather than carrying a possibly-bogus answer for the whole session.
// Subscribed at module scope and deliberately without React — this module is plain orchestration code
// with non-component callers, and the subscription lives as long as the tab does.
onlineManager.subscribe(online => {
	if (online) {
		unavailable.clear()
	}
})
// uuid -> the in-flight generation attempt, so two concurrent callers for the same uuid share one
// generation instead of each starting their own.
const pending = new InFlight<string, string | null>()
// uuid -> the live state of a SEEDED pending entry (seedThumbnail), for exactly as long as that entry
// exists. `joined` is flipped by getThumbnailUrl the moment it hands the seat's promise to a caller;
// the seat reads it to decide whether an unanswered production has anyone left to answer. An ordinary
// generation has no entry here — nothing but a seat ever needs to know it was joined.
const seats = new Map<string, { joined: boolean }>()

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
// failure there is logged and non-fatal. A transient failure to obtain bytes — a thrown error, an
// empty buffer, or no generator — is LOGGED ONLY (never surfaced to a user: thumbnail generation is
// silent by design) and counted against the blacklist; a SETTLED "unavailable" verdict instead joins
// the session-only `unavailable` set above and costs no strike.
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

		// The settled-verdict short-circuit sits BELOW the cache read on purpose: bytes landing on disk
		// must outrank an earlier verdict (the upload path can store a thumbnail for a uuid the listing
		// path already gave up on), so this only ever skips the generator, never the cache.
		if (unavailable.has(uuid)) {
			return null
		}

		let bytes: Uint8Array | undefined

		try {
			const generator = deps.getGenerator(category)
			const generated: ThumbGenerationResult = generator === undefined ? { type: "failed" } : await generator(item)

			if (generated.type === "bytes") {
				bytes = generated.bytes
			} else if (generated.type === "unavailable") {
				unavailable.add(uuid)

				return null
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
	// The base projection, so a shared file reaches the generators as the same file shape an owned one
	// does; its data still carries the sharing fields the SDK's AnyFile needs to read it as shared.
	const base = asDirectoryOrFile(item)

	if (category === "none" || base.type !== "file") {
		// The directory half is unreachable in practice (thumbnailCategory already returns "none" for
		// every directory arm) — kept so `base` narrows to its file arm below.
		return null
	}

	const uuid = base.data.uuid
	const cachedUrl = urls.get(uuid)

	if (cachedUrl !== undefined) {
		return cachedUrl
	}

	if ((failures.get(uuid) ?? 0) >= BLACKLIST_LIMIT) {
		return null
	}

	const inFlight = pending.get(uuid)

	if (inFlight !== undefined) {
		// Marked before the promise is handed over, so a seat that resolves nothing still knows it had
		// an audience worth falling through for.
		const seat = seats.get(uuid)

		if (seat !== undefined) {
			seat.joined = true
		}

		return inFlight
	}

	return pending.coalesce(uuid, () => generate(deps, base, category, uuid))
}

// Publishes an already-available production as THE in-flight generation for this item's uuid, so any
// caller that asks for this thumbnail while it runs joins it through the ordinary pending-map path
// instead of starting a second one. The upload path is the only caller, and it needs this seat:
// patching a freshly-uploaded file into the listing makes its tile ask for a thumbnail in the very
// next commit, and without a pending entry that tile would immediately start DOWNLOADING bytes the
// client still has in hand — the exact re-download the upload-side thumbnail exists to avoid.
//
// The production is deliberately run outside the generation semaphore: the SDK serialises its own
// decodes internally, so this adds no unbounded CPU demand, and a fifty-file upload batch must not be
// able to hold all three generation slots against the listing the user is actually looking at.
//
// Its two byte-less outcomes are NOT the same thing (ThumbSeedResult names them). A production that
// answers "none" has read the local bytes and settled "no thumbnail for this file" — null is the
// honest result, and it costs no blacklist strike (the ordinary server-side path keeps its full retry
// budget). A production that answers "unanswered" — it threw, or it refused on a limit of its own
// reading rather than on the file — has said nothing about the file at all, so the seat falls through
// to the ordinary path itself rather than pinning a joined caller to a null it will never re-ask for
// (useThumbnail runs its effect once per mount).
//
// That fall-through runs ONLY where a caller actually joined. The upload path seats a production for
// every file it uploads, including uploads into a directory nothing is rendering, whose rows never
// mount and never ask; generating server-side for one of those would queue range-read work through
// the three generation slots for a thumbnail nobody wants, which is exactly what running the
// production outside the semaphore exists to prevent. A caller that arrives after an unjoined seat is
// gone finds no pending entry, no strike and no verdict behind it, so it starts an ordinary
// generation of its own.
//
// A uuid that already has a rendered url or an in-flight generation is left alone.
export function seedThumbnail(
	item: DriveItem,
	produce: () => Promise<ThumbSeedResult>,
	deps: ThumbnailServiceDeps = defaultThumbnailDeps
): void {
	const category = thumbnailCategory(item)
	const base = asDirectoryOrFile(item)

	if (category === "none" || base.type !== "file") {
		// Same file-arm guard getThumbnailUrl carries above, for the same typing reason.
		return
	}

	const uuid = base.data.uuid

	if (urls.get(uuid) !== undefined || pending.has(uuid)) {
		return
	}

	const seat = { joined: false }

	seats.set(uuid, seat)

	// pending.has(uuid) was just checked false above, and this function is synchronous up to here
	// (no await before this point) — nothing else can touch `pending` for this uuid in between, so
	// coalesce() can only ever register a fresh entry here, never join an existing one. `seats` is a
	// web-only side table InFlight does not model, so its cleanup stays a manual .finally() chained
	// onto coalesce()'s own promise.
	void pending
		.coalesce(uuid, async () => {
			let result: ThumbSeedResult

			try {
				result = await produce()
			} catch (e) {
				log.warn("thumbnails", "seedThumbnail: production failed", uuid, e)

				result = { type: "unanswered" }
			}

			if (result.type === "unanswered") {
				// The fallback the doc comment above describes. It runs INSIDE generate's semaphore — the
				// download this seat displaced for the caller that joined it would have been gated too — and
				// inherits that path's whole retry/blacklist accounting, so nothing here counts a failure of
				// its own. Unjoined, there is no displaced download and no caller: the answer is nobody's.
				return seat.joined ? await generate(deps, base, category, uuid) : null
			}

			// An empty buffer is neither bytes to render nor a verdict to report; there is nothing here to
			// persist either way.
			if (result.type === "none" || result.bytes.length === 0) {
				return null
			}

			// Same ordering hazard generate() documents at length: the Blob must be built BEFORE the
			// persist call, because storeThumbnail's Comlink.transfer detaches this very buffer
			// synchronously at the postMessage, leaving a zero-length view behind.
			const attachedBytes = result.bytes as Uint8Array<ArrayBuffer>
			const blob = new Blob([attachedBytes])

			await deps.storeThumbnail(uuid, attachedBytes).catch((e: unknown) => {
				log.warn("thumbnails", "seedThumbnail: persist failed", uuid, e)
			})

			return finalize(deps, uuid, blob)
		})
		.finally(() => {
			seats.delete(uuid)
		})
}

// Drops a uuid's rendered thumbnail (revoking its objectURL) and its on-disk cache entry, drops any
// settled "unavailable" verdict, then clears exactly one blacklist strike — a uuid rotation or a torn
// write deserves one fresh attempt, not an automatic full reset of an otherwise-legitimate run of
// failures. `deps` defaults to the
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

	// A settled verdict is dropped outright rather than decremented: unlike a failure count it has no
	// notion of "one more try", and the two reasons to invalidate — a uuid rotation (genuinely
	// different content behind the same key) and a torn render — both mean the answer was about
	// something other than what will be asked for next.
	unavailable.delete(uuid)

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
