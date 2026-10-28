import * as Comlink from "comlink"
import { useSyncExternalStore } from "react"
import { type, type Type } from "arktype"
import {
	PHOTOS_DIR_NAME,
	PHOTOS_LIBRARY_FILE_NAME,
	PhotosLibraryVersionError,
	activePhotosRoots,
	emptyPhotosLibrary,
	hasPhotosRootRecords,
	hlcObserve,
	hlcTick,
	mergePhotosLibrary,
	parsePhotosLibrary,
	photosLibraryMaxStamp,
	samePhotosLibrary,
	serializePhotosLibrary,
	withPhotosRoot,
	withoutPhotosRoot,
	type Hlc,
	type PhotosLibraryDoc,
	type Stamp
} from "@filen/shared"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { onDotFilenSubdirForgotten } from "@/lib/dotFilen"
import { dotFilenDirectory } from "@/lib/dotFilenDirectory"
import { createListenerSet } from "@/lib/listenerSet"
import { kvDelete, kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { SYNCED_FILE_UPLOAD_DEADLINE_MS, SyncedDotFilenFile, type SyncedFileCodec } from "@/lib/syncedDotFilenFile"
import { forgetPhotosListingsExcept } from "@/features/photos/queries/photos"

// The directories the Photos timeline reads, synced end-to-end encrypted as `.filen/photos/library.v1.json`
// (@filen/shared's photosLibrary.ts for the format, lib/syncedDotFilenFile.ts for the syncing). The last copy read
// is kept locally too, so the timeline opens on its roots at once (offline too) while the file is read.

const CODEC: SyncedFileCodec<PhotosLibraryDoc> = {
	fileName: PHOTOS_LIBRARY_FILE_NAME,
	// A few hundred roots at most; anything this large is not the format.
	maxBytes: 256 * 1024,
	scope: "photos.library",
	empty: emptyPhotosLibrary,
	parse: parsePhotosLibrary,
	isNewerFormat: error => error instanceof PhotosLibraryVersionError,
	serialize: serializePhotosLibrary,
	merge: mergePhotosLibrary,
	same: samePhotosLibrary
}

// kv is wiped wholesale on logout, so neither key needs an account prefix. The legacy key held the one root of the
// local-only setting this file replaced; it is moved into the file once, then deleted.
const LEGACY_ROOT_KV_KEY = "photos.rootUuid.v1"
const LOCAL_COPY_KV_KEY = "photos.library.v1"

const legacyRootSchema: Type<string> = type("string")
const localCopySchema: Type<string> = type("string")

export const photosLibrary = /* @__PURE__ */ new SyncedDotFilenFile<PhotosLibraryDoc>(
	{
		...dotFilenDirectory(PHOTOS_DIR_NAME),
		upload: (parent, bytes) =>
			runOp(
				sdkApi.uploadFileBytes(parent, Comlink.transfer(bytes, [bytes.buffer]), PHOTOS_LIBRARY_FILE_NAME, "application/json", {
					deadlineMs: SYNCED_FILE_UPLOAD_DEADLINE_MS,
					abortToken: crypto.randomUUID()
				})
			)
	},
	CODEC,
	doc => {
		handleDoc(doc)
	}
)

// This tab's writer id and clock for stamping edits: one writer per tab, so two tabs never issue the same stamp.
const writerId = crypto.randomUUID().slice(0, 8)
let clock: Hlc = 0

function nextStamp(): Stamp {
	clock = hlcTick({
		clock,
		now: Date.now()
	})

	return {
		t: clock,
		d: writerId
	}
}

// What this device knew before the file is read: the local copy, else the legacy root (as a one-root document).
// undefined until both kv keys were read; null when there is neither.
let localCopy: PhotosLibraryDoc | null | undefined
let legacyRoot: string | null = null
let localRead: Promise<void> | null = null
// The serialized document last written to the local copy.
let persistedText: string | null = null
// The last read of the file failed (offline, say) and no read succeeded since.
let loadFailed = false
// The legacy root's move into the file while one runs, so every trigger joins it.
let migration: Promise<void> | null = null
const changes = createListenerSet("photos.library")

function parseLocalCopy(text: string | null): PhotosLibraryDoc | null {
	if (text === null) {
		return null
	}

	try {
		return parsePhotosLibrary(text)
	} catch {
		return null
	}
}

// Bumped by a sign-out, so a local read still out then answers no one.
let generation = 0

function readLocal(): Promise<void> {
	const readFor = generation

	localRead ??= (async () => {
		const [copyText, legacy] = await Promise.all([
			kvGetJson(LOCAL_COPY_KV_KEY, localCopySchema),
			kvGetJson(LEGACY_ROOT_KV_KEY, legacyRootSchema)
		])

		if (readFor !== generation) {
			return
		}

		legacyRoot = legacy
		persistedText = copyText
		localCopy =
			parseLocalCopy(copyText) ??
			(legacy === null ? null : withPhotosRoot({ doc: emptyPhotosLibrary(), dirUuid: legacy, stamp: { t: 0, d: writerId }, now: 0 }))
		changes.emit()
	})().catch((error: unknown) => {
		log.warn("photos.library", "local copy not read", { error })

		if (readFor === generation) {
			localCopy = null
			changes.emit()
		}
	})

	return localRead
}

// Every document the file delivers: the clock follows it, and once read it becomes the local copy.
function handleDoc(doc: PhotosLibraryDoc): void {
	clock = hlcObserve({
		clock,
		seen: photosLibraryMaxStamp(doc),
		now: Date.now()
	})

	if (!photosLibrary.isLoaded) {
		return
	}

	loadFailed = false

	const text = serializePhotosLibrary(doc)

	if (text !== persistedText) {
		persistedText = text
		kvSetJson(LOCAL_COPY_KV_KEY, text).catch((error: unknown) => {
			log.warn("photos.library", "local copy not written", { error })
		})
	}

	// A root no longer in the library (removed here or elsewhere, replaced, gone) keeps no listing, in memory or on
	// disk. The legacy root counts until it is moved in, so its listing survives the move.
	const active = new Set(activePhotosRoots(doc).map(root => root.dirUuid))

	if (legacyRoot !== null) {
		active.add(legacyRoot)
	}

	forgetPhotosListingsExcept(active)

	void migrateLegacyRoot()
}

// The local-only root of before seeds a file that never held a root (one that did, removed ones included, already
// says what the user wants). Decided on the file as stored, never on a change still waiting for its upload; the
// legacy key goes only once the stored file holds a root, so a failed or refused upload keeps it for a retry.
function migrateLegacyRoot(): Promise<void> {
	const root = legacyRoot

	if (root === null) {
		return Promise.resolve()
	}

	migration ??= moveLegacyRoot(root).finally(() => {
		migration = null
	})

	return migration
}

async function moveLegacyRoot(root: string): Promise<void> {
	try {
		if (!hasPhotosRootRecords(photosLibrary.syncedValue())) {
			// Seeded already when an earlier upload failed: only that upload is retried.
			await (hasPhotosRootRecords(photosLibrary.value())
				? photosLibrary.save()
				: photosLibrary.change(doc => withPhotosRoot({ doc, dirUuid: root, stamp: nextStamp(), now: Date.now() }), {
						requireWritable: true
					}))
		}

		if (!hasPhotosRootRecords(photosLibrary.syncedValue())) {
			return
		}

		await kvDelete(LEGACY_ROOT_KV_KEY)
		legacyRoot = null
	} catch (error) {
		log.warn("photos.library", "legacy root not moved into the synced library", { error })
	}
}

// Reads the local copy, then the file (once per session, again after another session saved it). A failure is
// logged; the local copy stays in effect, and the file is read again later on its own.
export async function loadPhotosLibrary(): Promise<void> {
	await readLocal()

	try {
		await photosLibrary.load()
	} catch (error) {
		log.warn("photos.library", "photos library not loaded", { error })

		if (!photosLibrary.isLoaded) {
			loadFailed = true
			changes.emit()
		}

		return
	}

	// Resolves once the legacy root's move settled. A read that changed nothing delivers no document: a move left
	// pending by a failed upload is tried here.
	await migrateLegacyRoot()
}

export interface PhotosLibraryView {
	// The roots in the order they were added; null until known (neither the file nor a local copy read yet).
	roots: readonly string[] | null
	// The file was read this session: edits can be made.
	loaded: boolean
	// The file was written by a newer version: shown, never changed here.
	readOnly: boolean
}

let viewCache: {
	doc: PhotosLibraryDoc | null
	loaded: boolean
	readOnly: boolean
	view: PhotosLibraryView
} | null = null

function currentDoc(): PhotosLibraryDoc | null {
	if (photosLibrary.isLoaded) {
		return photosLibrary.value()
	}

	if (localCopy !== undefined && localCopy !== null) {
		return localCopy
	}

	return localCopy === null && loadFailed ? emptyPhotosLibrary() : null
}

export function photosLibraryView(): PhotosLibraryView {
	const doc = currentDoc()
	const loaded = photosLibrary.isLoaded
	const readOnly = loaded && photosLibrary.isReadOnly

	if (viewCache?.doc !== doc || viewCache.loaded !== loaded || viewCache.readOnly !== readOnly) {
		viewCache = {
			doc,
			loaded,
			readOnly,
			view: {
				roots: doc === null ? null : activePhotosRoots(doc).map(root => root.dirUuid),
				loaded,
				readOnly
			}
		}
	}

	return viewCache.view
}

function subscribe(listener: () => void): () => void {
	const offFile = photosLibrary.subscribe(listener)
	const offLocal = changes.subscribe(listener)

	return () => {
		offFile()
		offLocal()
	}
}

export function usePhotosLibrary(): PhotosLibraryView {
	return useSyncExternalStore(subscribe, photosLibraryView, photosLibraryView)
}

// The current roots for a reader outside React (the assistant): the file as read now, else the local copy.
export async function photosLibraryRoots(): Promise<readonly string[]> {
	await loadPhotosLibrary()

	return photosLibraryView().roots ?? []
}

// Edits apply to the file as read (so a removal reaches a root another session added): they wait for the read, and
// fail when it can't be made, or when the file was written by a newer version (SyncedFileReadOnlyError). Resolves
// once uploaded.
async function edit(change: (doc: PhotosLibraryDoc, stamp: Stamp) => PhotosLibraryDoc): Promise<void> {
	await readLocal()
	await photosLibrary.load()
	await photosLibrary.change(doc => change(doc, nextStamp()), { requireWritable: true })
}

// Adds `uuid` in place of the roots it overlaps (`replace`).
export function addPhotosRoot({ uuid, replace }: { uuid: string; replace: readonly string[] }): Promise<void> {
	return edit((doc, stamp) => {
		const now = Date.now()
		let next = doc

		for (const dirUuid of replace) {
			if (dirUuid !== uuid) {
				next = withoutPhotosRoot({ doc: next, dirUuid, stamp, at: now })
			}
		}

		return withPhotosRoot({ doc: next, dirUuid: uuid, stamp, now })
	})
}

export function removePhotosRoot(uuid: string): Promise<void> {
	return edit((doc, stamp) => withoutPhotosRoot({ doc, dirUuid: uuid, stamp, at: Date.now() }))
}

// Called once by the authed shell's socket host.
export function registerPhotosLibrarySocketHandlers(): () => void {
	const unregister = [
		registerSocketHandler("drive", event => {
			photosLibrary.handleDriveEvent(event)
		}),
		registerSocketHandler("driveMalformed", () => {
			photosLibrary.markStale()
		}),
		registerSocketHandler("reconnecting", () => {
			photosLibrary.markStale()
		}),
		onDotFilenSubdirForgotten(PHOTOS_DIR_NAME, () => {
			photosLibrary.markStale()
		})
	]

	return () => {
		for (const off of unregister) off()
	}
}

// Sign-out: nothing of this account survives (kv itself is wiped by the logout).
export function resetPhotosLibrary(): void {
	generation++
	photosLibrary.reset()
	localCopy = undefined
	legacyRoot = null
	localRead = null
	persistedText = null
	loadFailed = false
	migration = null
	clock = 0
	viewCache = null
	changes.emit()
}
