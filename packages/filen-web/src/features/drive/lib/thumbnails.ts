import * as Comlink from "comlink"
import { onlineManager } from "@tanstack/react-query"
import { Semaphore } from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { defaultObjectUrlFns, type ObjectUrlFns } from "@/lib/objectUrl"
import { readThumbnailBlob, deleteThumbnail as deleteThumbnailBlob } from "@/features/drive/lib/thumbCache"
import { thumbnailCategory, type ThumbnailCategory, type ThumbnailCopy } from "@/features/drive/lib/thumbnails.logic"
import { asDirectoryOrFile, type BaseFileItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveViewMode } from "@/features/drive/lib/preferences"
import { createThumbnailUrlCache, capacityForVisibleSlots, computeThumbnailCapacity } from "@/features/drive/lib/thumbnailUrlCache"

// No declared mime on rendered thumbnail blobs: the format genuinely varies by producer. The SDK arm
// always encodes webp in wasm, while the video/pdf/svg canvas encodes are webp where the browser
// supports it and legally fall back to jpeg (png for svg) where it doesn't — so a hardcoded label
// would lie for some of these bytes, and the OPFS cache-hit path (a raw File for a .thumb extension)
// carries no reliable type either. <img> sources are content-sniffed regardless, so untyped is the
// one consistent, honest option for every path.

// How many generator runs happen at once, app-wide — shapes DEMAND on the CPU/SDK-download layer,
// never a limit the SDK itself needs (never reimplement SDK-side concurrency; this bounds how many
// requests THIS app issues concurrently). The OPFS cache read stays outside it: see generate().
const CONCURRENT_GENERATIONS = 3

// Permanent-failure threshold — the third failed generation for a uuid blacklists it for the rest of
// the session, short-circuiting every later call instead of repeating pointless work (a download that
// keeps failing, a decode worker that keeps dying, or — until generators are registered — an
// unimplemented category). A SETTLED verdict is NOT one of these; see `unavailable` below.
const BLACKLIST_LIMIT = 3

// Every non-"none" category routes through the generator registry — sdk/video/pdf/svg alike. The service
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

// `signal` aborts once no cell has wanted the generation for DROP_GRACE_MS. A generator stops only where
// stopping still saves real work (before its expensive part starts, or a download not yet half done)
// and otherwise finishes: the result is cached for the next time a cell asks. A stopped generator
// resolves "failed" or throws, which the service then counts as neither a failure nor a verdict.
export type ThumbGenerator = (item: BaseFileItem, signal: AbortSignal) => Promise<ThumbGenerationResult>

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
export interface ThumbnailServiceDeps extends ObjectUrlFns {
	readThumbnailBlob: (uuid: string) => Promise<Blob | null>
	deleteThumbnail: (uuid: string) => Promise<void>
	storeThumbnail: (uuid: string, bytes: Uint8Array) => Promise<void>
	copyThumbnails: (copies: ThumbnailCopy[]) => Promise<void>
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
	copyThumbnails: copies => sdkApi.copyThumbnails(copies),
	...defaultObjectUrlFns,
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
// How long a generation nobody wants keeps running before its generator is told to stop: long enough
// for a cell scrolled straight back (or React's StrictMode remount) to claim it again.
const DROP_GRACE_MS = 300

// Who still wants a pending generation. A caller with an AbortSignal counts as interest until it aborts;
// one without (and every seat) pins the entry. An unpinned generation nobody wants any more is dropped
// when it reaches a generation slot instead of downloading and decoding for a cell that scrolled away;
// one already running is signalled through `controller` (see ThumbGenerator).
interface PendingClaim {
	interest: number
	pinned: boolean
	abandoned: boolean
	controller: AbortController
	dropTimer: ReturnType<typeof setTimeout> | undefined
	// Ended without an answer because nobody wanted it, as opposed to a failure or a verdict.
	dropped: boolean
	settled: boolean
}

interface PendingEntry {
	promise: Promise<string | null>
	claim: PendingClaim
}

// uuid -> the in-flight generation attempt, so two concurrent callers for the same uuid share one
// generation instead of each starting their own.
const pending = new Map<string, PendingEntry>()
// uuid -> the live state of a SEEDED pending entry (seedThumbnail), for exactly as long as that entry
// exists. `joined` is flipped by getThumbnailUrl the moment it hands the seat's promise to a caller;
// the seat reads it to decide whether an unanswered production has anyone left to answer. An ordinary
// generation has no entry here — nothing but a seat ever needs to know it was joined.
const seats = new Map<string, { joined: boolean }>()

const semaphore = new Semaphore(CONCURRENT_GENERATIONS)

// Runs a seeded production that decodes in the browser (video, pdf) in one of the generation slots: it
// costs what the generation it replaces would have, less the download.
export function withGenerationSlot<T>(produce: () => Promise<T>): Promise<T> {
	return semaphore.withPermit(produce)
}

// A copy job's thumbnails go to the worker in batches of at most this many, one batch at a time, so a
// job of any size keeps one call in flight and the worker's own gate bounds the OPFS work under it.
const REUSE_BATCH_SIZE = 256

interface ReuseBatch {
	copies: ThumbnailCopy[]
	done: Promise<undefined>
	settle: (value: undefined) => void
}

// Batches not yet handed to the worker, oldest first; only the last one still takes copies.
const reuseQueue: ReuseBatch[] = []
let reuseDraining = false
// Destination uuid -> the batch that may give it its source's thumbnail. generate() waits on it before
// reading the cache, so a copied row that mounts meanwhile reads the copy instead of generating one.
const reusing = new Map<string, Promise<undefined>>()

// Registers run's promise as THE pending entry for uuid, removed once settled only while it is still
// that entry, so a superseded promise never evicts a newer one.
function startPending(uuid: string, pinned: boolean, run: (claim: PendingClaim) => Promise<string | null>): PendingEntry {
	const claim: PendingClaim = {
		interest: 0,
		pinned,
		abandoned: false,
		controller: new AbortController(),
		dropTimer: undefined,
		dropped: false,
		settled: false
	}
	const entry: PendingEntry = { promise: run(claim), claim }
	const settle = (): void => {
		claim.settled = true
		clearTimeout(claim.dropTimer)

		if (pending.get(uuid) === entry) {
			pending.delete(uuid)
		}
	}

	pending.set(uuid, entry)
	void entry.promise.then(settle, settle)

	return entry
}

// The abort listener closes over the claim itself, never a uuid lookup: a late abort must not touch a
// newer generation for the same uuid.
function registerInterest(claim: PendingClaim, signal: AbortSignal | undefined): void {
	if (signal === undefined) {
		claim.pinned = true

		return
	}

	if (signal.aborted) {
		return
	}

	claim.interest++
	clearTimeout(claim.dropTimer)

	signal.addEventListener(
		"abort",
		() => {
			claim.interest--

			if (claim.settled || claim.pinned || claim.interest > 0) {
				return
			}

			clearTimeout(claim.dropTimer)

			claim.dropTimer = setTimeout(() => {
				if (!claim.pinned && claim.interest <= 0) {
					claim.controller.abort()
				}
			}, DROP_GRACE_MS)
		},
		{ once: true }
	)
}

function unwanted(claim: PendingClaim): boolean {
	return claim.controller.signal.aborted || (!claim.pinned && claim.interest <= 0)
}

function finalize(deps: ThumbnailServiceDeps, uuid: string, blob: Blob): string {
	const url = deps.createObjectUrl(blob)
	urls.set(uuid, url)
	return url
}

// Persists freshly produced bytes (a failure is logged and non-fatal) and finalizes them. The generic
// ArrayBufferLike-vs-ArrayBuffer parameter on Uint8Array (TS lib.es2024.arraybuffer) makes an
// unparameterized Uint8Array reject BlobPart's stricter ArrayBufferView<ArrayBuffer> — bytes here is
// always backed by a real ArrayBuffer (a producer's own freshly-allocated buffer, never a
// SharedArrayBuffer), so the cast narrows the generic parameter only, mirroring imageViewer.tsx's
// identical cast. The Blob is built BEFORE the persist call: the Blob constructor copies bytes into
// its own storage immediately, whereas storeThumbnail's Comlink.transfer detaches this SAME buffer
// synchronously, at the call itself (postMessage's transfer-list handoff, not once the call resolves)
// — persisting first would leave `bytes` a zero-length view, silently producing an empty Blob.
//
// A persisted thumbnail is then served from its stored file, whose Blob is backed by disk rather than by
// a copy of the bytes in memory — what lets the url cache hold many entries for next to nothing. Only a
// file of exactly this size counts: a persist another tab's writer skipped may still be mid-write.
async function persistAndFinalize(deps: ThumbnailServiceDeps, uuid: string, bytes: Uint8Array, label: string): Promise<string> {
	const attachedBytes = bytes as Uint8Array<ArrayBuffer>
	const blob = new Blob([attachedBytes])

	const persisted = await deps.storeThumbnail(uuid, attachedBytes).then(
		() => true,
		(e: unknown) => {
			log.warn("thumbnails", `${label}: persist failed`, uuid, e)

			return false
		}
	)
	const stored = persisted ? await deps.readThumbnailBlob(uuid).catch(() => null) : null

	return finalize(deps, uuid, stored !== null && stored.size === blob.size ? stored : blob)
}

// The one real generation attempt for a uuid: check the OPFS cache first (another tab, or an earlier
// session, may have already produced this thumbnail), then route through the registered generator for
// the category (an unregistered category resolves no bytes, same as any other failure below). Only the
// generator runs under the app-wide semaphore: a cache hit is a local read, and gating it would park
// every already-cached tile behind whichever slow video/PDF generations hold the slots; the mounted
// tiles already bound how many reads run at once. A generated result is written back through
// storeThumbnail — a persist failure there is logged and non-fatal. A transient failure to obtain
// bytes — a thrown error, an empty buffer, or no generator — is LOGGED ONLY (never surfaced to a user:
// thumbnail generation is silent by design) and counted against the blacklist; a SETTLED
// "unavailable" verdict instead joins the session-only `unavailable` set above and costs no strike.
// Work that lost every interested caller while queued is dropped on reaching its slot, and a generator
// that stopped on the claim's signal ends the same way: neither a failure nor a verdict.
async function generate(
	deps: ThumbnailServiceDeps,
	item: BaseFileItem,
	category: Exclude<ThumbnailCategory, "none">,
	uuid: string,
	claim: PendingClaim
): Promise<string | null> {
	// A read failure beyond the clean miss (readThumbnailBlob only maps NotFoundError to null — e.g. a
	// quota/permission DOMException, or an eviction sweep racing this read) must degrade to the
	// ordinary generate path, NOT reject out of the shared pending promise: a rejection would break the
	// never-throws contract for every caller joined on this uuid AND skip the failure counter below,
	// bypassing the blacklist into a retry-forever loop.
	const reuse = reusing.get(uuid)

	if (reuse !== undefined) {
		await reuse
	}

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

	await semaphore.acquire()

	// Synchronous with the removal, so no caller can join the entry between the check and the null.
	if (unwanted(claim)) {
		claim.abandoned = true
		claim.dropped = true

		if (pending.get(uuid)?.claim === claim) {
			pending.delete(uuid)
		}

		semaphore.release()

		return null
	}

	try {
		let bytes: Uint8Array | undefined

		try {
			const generator = deps.getGenerator(category)
			const generated: ThumbGenerationResult =
				generator === undefined ? { type: "failed" } : await generator(item, claim.controller.signal)

			if (generated.type === "bytes") {
				bytes = generated.bytes
			} else if (generated.type === "unavailable") {
				unavailable.add(uuid)

				return null
			}
		} catch (e) {
			if (!claim.controller.signal.aborted) {
				log.warn("thumbnails", "generate: generation failed", uuid, e)
			}
		}

		if (bytes === undefined && claim.controller.signal.aborted) {
			claim.dropped = true

			return null
		}

		if (bytes === undefined || bytes.length === 0) {
			failures.set(uuid, (failures.get(uuid) ?? 0) + 1)
			return null
		}

		return await persistAndFinalize(deps, uuid, bytes, "generate")
	} finally {
		semaphore.release()
	}
}

// The cached objectURL for a uuid, synchronously, so a mounting cell can render it on its first frame.
// Touches LRU recency exactly as getThumbnailUrl's own cache hit does.
export function peekThumbnailUrl(uuid: string): string | null {
	return urls.get(uuid) ?? null
}

// The service's one read entry point. Routing order: no category -> null; a live objectURL -> reuse
// it; blacklisted -> null without touching the cache/semaphore again; an in-flight generation for
// this uuid -> join it; otherwise start a fresh generation. `deps` defaults to the
// real worker/OPFS/Blob-URL wiring — pass a fake for tests. `signal` scopes this caller's interest in
// a generation that has not started yet (see PendingClaim); without one the generation always runs.
export async function getThumbnailUrl(
	item: DriveItem,
	deps: ThumbnailServiceDeps = defaultThumbnailDeps,
	signal?: AbortSignal
): Promise<string | null> {
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
	const cachedUrl = peekThumbnailUrl(uuid)

	if (cachedUrl !== null) {
		return cachedUrl
	}

	if ((failures.get(uuid) ?? 0) >= BLACKLIST_LIMIT) {
		return null
	}

	let entry = pending.get(uuid)

	if (entry === undefined || entry.claim.abandoned) {
		entry = startPending(uuid, false, claim => generate(deps, base, category, uuid, claim))
	} else if (entry.claim.controller.signal.aborted) {
		// Told to stop, but its generator may be finishing work it was already well into: wait for that
		// rather than start a second one, and generate afresh only if it really stopped.
		const prior = entry

		entry = startPending(uuid, false, async claim => {
			const url = await prior.promise

			return url === null && prior.claim.dropped ? await generate(deps, base, category, uuid, claim) : url
		})
	} else {
		// Marked before the promise is handed over, so a seat that resolves nothing still knows it had
		// an audience worth falling through for.
		const seat = seats.get(uuid)

		if (seat !== undefined) {
			seat.joined = true
		}
	}

	registerInterest(entry.claim, signal)

	return entry.promise
}

// Publishes an already-available production as THE in-flight generation for this item's uuid, so any
// caller that asks for this thumbnail while it runs joins it through the ordinary pending-map path
// instead of starting a second one. The upload path is the only caller, and it needs this seat:
// patching a freshly-uploaded file into the listing makes its tile ask for a thumbnail in the very
// next commit, and without a pending entry that tile would immediately start DOWNLOADING bytes the
// client still has in hand — the exact re-download the upload-side thumbnail exists to avoid.
//
// The production runs outside the generation semaphore unless it takes a slot itself
// (withGenerationSlot): the SDK serialises its own decodes internally, so an SDK production adds no
// unbounded CPU demand, and a fifty-file upload batch must not be able to hold all three generation
// slots against the listing the user is actually looking at. A browser decode has no such bound.
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
	// (no await before this point) — nothing else can touch `pending` for this uuid in between, so this
	// always registers a fresh entry. Pinned: the production runs outside the semaphore, and its
	// fall-through serves a caller that joined.
	void startPending(uuid, true, async claim => {
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
			return seat.joined ? await generate(deps, base, category, uuid, claim) : null
		}

		// An empty buffer is neither bytes to render nor a verdict to report; there is nothing here to
		// persist either way.
		if (result.type === "none" || result.bytes.length === 0) {
			return null
		}

		return persistAndFinalize(deps, uuid, result.bytes, "seedThumbnail")
	}).promise.finally(() => {
		seats.delete(uuid)
	})
}

async function drainReuseQueue(deps: ThumbnailServiceDeps): Promise<void> {
	reuseDraining = true

	try {
		for (let batch = reuseQueue.shift(); batch !== undefined; batch = reuseQueue.shift()) {
			try {
				await deps.copyThumbnails(batch.copies)
			} catch (e) {
				log.warn("thumbnails", "reuseCopiedThumbnails: batch failed", e)
			} finally {
				for (const copy of batch.copies) {
					reusing.delete(copy.to)
				}

				batch.settle(undefined)
			}
		}
	} finally {
		reuseDraining = false
	}
}

// Hands each copied file its source's thumbnail with no network: the source's cached bytes are copied
// under the new uuid on disk, and a settled "unavailable" verdict carries over at once so the copy
// never attempts what its source could not. A source with nothing cached leaves its copy to the
// ordinary lazy path. Fire-and-forget; a destination that already has a url, a generation or a copy
// under way is left alone.
export function reuseCopiedThumbnails(copies: readonly ThumbnailCopy[], deps: ThumbnailServiceDeps = defaultThumbnailDeps): void {
	for (const copy of copies) {
		if (urls.peek(copy.to) !== undefined || pending.has(copy.to) || reusing.has(copy.to)) {
			continue
		}

		if (unavailable.has(copy.from)) {
			unavailable.add(copy.to)

			continue
		}

		let batch = reuseQueue.at(-1)

		if (batch === undefined || batch.copies.length >= REUSE_BATCH_SIZE) {
			const { promise, resolve } = Promise.withResolvers<undefined>()

			batch = { copies: [], done: promise, settle: resolve }
			reuseQueue.push(batch)
		}

		batch.copies.push(copy)
		reusing.set(copy.to, batch.done)
	}

	if (!reuseDraining && reuseQueue.length > 0) {
		void drainReuseQueue(deps)
	}
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

// The same resize for a surface that counts its own slots (the photos grid lays out its own tiles).
export function setThumbnailVisibleSlots(visibleSlots: number): void {
	urls.setCapacity(capacityForVisibleSlots(visibleSlots))
}
