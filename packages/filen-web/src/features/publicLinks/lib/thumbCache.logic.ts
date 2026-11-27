import type { OpfsBlobStore } from "@/lib/storage/opfs"

// A public directory link's thumbnails on disk: decrypted derivatives of someone else's files, so never in the drive's
// plaintext store. Each tab writes under its own directory, sealed with AES-GCM under a key that tab generated, cannot
// export and holds only in memory: once the tab is gone nothing can read them, and the next tab's first use removes
// them (its directory's lock is no longer held).

// Its own tree: the drive's sweep removes every directory under THUMB_DIR_ROOT but its live generation.
export const LINK_THUMB_DIR_ROOT = ["linkThumbnails"]

const LINK_THUMB_EXT = ".thumb"

const IV_BYTES = 12
const TAG_BYTES = 16

const TAB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// A tab's directory name is a random uuid; anything else under the root is no tab's.
export function isLinkThumbTab(name: string): boolean {
	return TAB_PATTERN.test(name)
}

// Only a write creates the tree, so a visit that stores nothing leaves no trace; a write after a wipe (sign-out or
// the Storage page's clear in any tab) creates it again.
export function linkThumbStore(tab: string): OpfsBlobStore {
	return { dir: [...LINK_THUMB_DIR_ROOT, tab], ext: LINK_THUMB_EXT, createOnWriteOnly: true }
}

// Held by the tab for its whole life: a directory whose lock nobody holds belongs to a tab that is gone.
export function linkThumbLock(tab: string): string {
	return `filen-link-thumbnails:${tab}`
}

export function generateLinkThumbKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

// The uuid is the additional data, so an entry only opens under the name it was sealed for.
function gcm(iv: Uint8Array<ArrayBuffer>, uuid: string): AesGcmParams {
	return { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(uuid) }
}

// The IV, then the ciphertext with its tag.
export async function sealLinkThumb(key: CryptoKey, uuid: string, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
	const sealed = new Uint8Array(await crypto.subtle.encrypt(gcm(iv, uuid), key, bytes))
	const out = new Uint8Array(IV_BYTES + sealed.length)

	out.set(iv)
	out.set(sealed, IV_BYTES)

	return out
}

// Null for anything that does not open under `key` as `uuid`'s: another tab's key, a torn write, another name.
export async function openLinkThumb(
	key: CryptoKey,
	uuid: string,
	sealed: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer> | null> {
	if (sealed.length < IV_BYTES + TAG_BYTES) {
		return null
	}

	try {
		return new Uint8Array(await crypto.subtle.decrypt(gcm(sealed.slice(0, IV_BYTES), uuid), key, sealed.subarray(IV_BYTES)))
	} catch {
		return null
	}
}
