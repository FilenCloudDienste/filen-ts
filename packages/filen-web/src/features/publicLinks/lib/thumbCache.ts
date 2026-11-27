import * as Comlink from "comlink"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"
import { isNotFoundError, opfsDirectory, type OpfsBlobStore } from "@/lib/storage/opfs"
import { deleteStoreEntry, readStoreBlob, wipeOpfsTree } from "@/lib/storage/opfsBlobStore"
import {
	LINK_THUMB_DIR_ROOT,
	generateLinkThumbKey,
	isLinkThumbTab,
	linkThumbLock,
	linkThumbStore,
	openLinkThumb,
	sealLinkThumb
} from "@/features/publicLinks/lib/thumbCache.logic"

// The page's side of a public link's sealed thumbnail store (thumbCache.logic.ts): this tab's key and directory, the
// read (OPFS read, then open) and the seal before the SDK worker writes. Reads and deletes run here, like the drive's
// (features/drive/lib/thumbCache.ts); a write needs a sync access handle, which only the worker has.

interface TabStore {
	tab: string
	key: CryptoKey
	store: OpfsBlobStore
}

// Made on first use; null where this browser cannot keep one (no Web Locks, OPFS or WebCrypto), and every read
// then misses and every write is dropped.
let opened: Promise<TabStore | null> | null = null

function tabStore(): Promise<TabStore | null> {
	opened ??= openTabStore().catch((e: unknown) => {
		log.warn("link-thumbnails", "no sealed store this tab", e)

		return null
	})

	return opened
}

function supported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"locks" in navigator &&
		"storage" in navigator &&
		typeof navigator.storage.getDirectory === "function" &&
		"subtle" in crypto
	)
}

// The lock is taken before anything is written under the directory, so a sweep never sees this tab's directory
// without it; it is held until the tab goes.
function holdLock(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		navigator.locks
			.request(name, () => {
				resolve()

				return new Promise<never>(() => undefined)
			})
			.catch(reject)
	})
}

async function openTabStore(): Promise<TabStore | null> {
	if (!supported()) {
		return null
	}

	const tab = crypto.randomUUID()

	await holdLock(linkThumbLock(tab))

	const key = await generateLinkThumbKey()

	void sweepGoneTabs(tab).catch((e: unknown) => {
		log.warn("link-thumbnails", "sweep failed", e)
	})

	return { tab, key, store: linkThumbStore(tab) }
}

// Removes every directory of a tab that is gone: written under a key nothing holds any more. Listed before the
// locks are asked for, so a tab that started meanwhile already holds its lock by the time it is checked. Creates
// nothing: with no tree yet there is nothing to sweep, and this tab's first write creates it.
async function sweepGoneTabs(own: string): Promise<void> {
	let root: FileSystemDirectoryHandle

	try {
		root = await opfsDirectory(LINK_THUMB_DIR_ROOT, false)
	} catch (e) {
		if (isNotFoundError(e)) {
			return
		}

		throw e
	}

	const names: string[] = []

	for await (const handle of root.values()) {
		if (handle.name !== own) {
			names.push(handle.name)
		}
	}

	if (names.length === 0) {
		return
	}

	const { held = [] } = await navigator.locks.query()
	const live = new Set(held.map(lock => lock.name))

	for (const name of names) {
		if (isLinkThumbTab(name) && live.has(linkThumbLock(name))) {
			continue
		}

		try {
			await root.removeEntry(name, { recursive: true })
		} catch (e) {
			if (!isNotFoundError(e)) {
				log.warn("link-thumbnails", "sweep: remove failed", name, e)
			}
		}
	}
}

// This tab's thumbnail of `uuid`, opened; null on a miss. An entry that does not open (a torn write) is removed.
export async function readLinkThumbnail(uuid: string): Promise<Blob | null> {
	const tab = await tabStore()

	if (tab === null) {
		return null
	}

	const file = await readStoreBlob(tab.store, uuid)

	if (file === null) {
		return null
	}

	const bytes = await openLinkThumb(tab.key, uuid, new Uint8Array(await file.arrayBuffer()))

	if (bytes === null) {
		void deleteLinkThumbnail(uuid).catch((e: unknown) => {
			log.warn("link-thumbnails", "delete of an unreadable entry failed", uuid, e)
		})

		return null
	}

	return new Blob([bytes])
}

// Seals `bytes` (left whole: the caller still serves them) and hands the sealed copy to the worker that writes it.
// The bytes are a producer's own buffer, never a SharedArrayBuffer, so the cast narrows the generic parameter only.
export async function storeLinkThumbnail(uuid: string, bytes: Uint8Array): Promise<void> {
	const tab = await tabStore()

	if (tab === null) {
		return
	}

	const sealed = await sealLinkThumb(tab.key, uuid, bytes as Uint8Array<ArrayBuffer>)

	await sdkApi.storeLinkedThumbnail(tab.tab, uuid, Comlink.transfer(sealed, [sealed.buffer]))
}

export async function deleteLinkThumbnail(uuid: string): Promise<void> {
	const tab = await tabStore()

	if (tab !== null) {
		await deleteStoreEntry(tab.store, uuid)
	}
}

// Sign-out and the Storage page's clear: every tab's sealed thumbnails, those of every other open link tab included
// (they regenerate on demand). This tab keeps its key, and its next write creates the tree again.
export async function wipeLinkThumbnailStore(): Promise<void> {
	const tab = opened === null ? null : await opened

	await wipeOpfsTree(LINK_THUMB_DIR_ROOT, tab === null ? [] : [tab.store.dir])
}
