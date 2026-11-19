import type { AnyFile, ArchiveEntryId } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"
import { log } from "@/lib/log"

// The page's side of the SDK worker's archive readers: one per archive, client and password, shared by every caller
// (the browser's listing, the entries it opens, a save, an iWork preview, a comic). Each acquire holds a reference;
// once the last is released a reader holding more than a little read ahead closes at once, and any other lingers a
// while, so a viewer closed and the next one opened find the index and the decoder states the SDK keeps for it. Sign-out
// closes every one at once.

export const READER_LINGER_MS = 30_000
// Above this much held read ahead, a reader nobody holds closes at once rather than linger. Only the worker's JS
// read-ahead is counted: the SDK states no reader's retained bytes (its index, chunks and decoder states, which its own
// retained budget bounds across readers).
export const READER_CLOSE_AT_ONCE_BYTES = 4 * 1024 * 1024

// An archive inside another's entry: read through its parent's reader, at most three deep.
export interface NestedSource {
	readonly parent: ReaderTarget
	// The parent's password, which its reader was opened with.
	readonly parentPassword: string | undefined
	// The entry holding it, in the parent's listing.
	readonly index: number
	// 2 for an archive inside a drive file's, 3 at most.
	readonly depth: number
}

// Archives in all, the file's own counted first. Stricter than the SDK on purpose: its
// MAX_NESTING allows three archives nested inside the file's (four in all), so the page's cap is the one that binds, and
// a nested open never meets the SDK's refusal.
export const MAX_NESTED_DEPTH = 3

// What a reader is opened on: a drive or public link file, or an archive nested in one. `uuid` names it in the page's
// caches and in the entry ids the page passes (the file's uuid; `${parent uuid}/${index}` for a nested one, which the
// worker maps to the SDK's own id).
export interface ReaderTarget {
	readonly file: AnyFile
	readonly uuid: string
	// Read through the public-link client, never the session's.
	readonly anon: boolean
	readonly nested: NestedSource | null
}

// A drive or public link file's archive.
export function fileTarget(file: AnyFile, anon: boolean): ReaderTarget {
	return { file, uuid: file.uuid, anon, nested: null }
}

// The archive in the entry `index` of `parent`'s listing; null past MAX_NESTED_DEPTH.
export function nestedTarget(parent: ReaderTarget, parentPassword: string | undefined, index: number): NestedSource | null {
	const depth = (parent.nested?.depth ?? 1) + 1

	return depth > MAX_NESTED_DEPTH ? null : { parent, parentPassword, index, depth }
}

export function nestedUuid(parent: ReaderTarget, index: number): string {
	return `${parent.uuid}/${String(index)}`
}

export interface ArchiveReaderRef {
	// The worker's reader id.
	readonly id: string
	readonly anon: boolean
	readonly password: string | undefined
	// False once the reader was closed under it (sign-out).
	readonly isOpen: () => boolean
	// Drops this reference; idempotent.
	readonly release: () => void
}

export interface ArchiveReaderPageDeps {
	open: (id: string, file: AnyFile, anon: boolean, password: string | undefined) => void
	openNested: (id: string, parentId: string, entry: ArchiveEntryId, password: string | undefined) => void
	close: (id: string) => void
	heldBytes: (id: string) => Promise<number>
	newId: () => string
	linger: (close: () => void) => () => void
}

export const defaultArchiveReaderPageDeps: ArchiveReaderPageDeps = {
	// A refused open (signed out meanwhile) shows on the reader's first read, as a cancel.
	open: (id, file, anon, password) => {
		sdkApi.openArchiveReader(id, file, anon, password).catch((e: unknown) => {
			log.warn("archiveReaders", "opening a reader failed", e)
		})
	},
	openNested: (id, parentId, entry, password) => {
		sdkApi.openNestedArchiveReader(id, parentId, entry, password).catch((e: unknown) => {
			log.warn("archiveReaders", "opening a nested reader failed", e)
		})
	},
	close: id => {
		sdkApi.closeArchiveReader(id).catch((e: unknown) => {
			log.warn("archiveReaders", "closing a reader failed", e)
		})
	},
	heldBytes: id => sdkApi.archiveReaderHeldBytes(id).catch(() => 0),
	newId: () => crypto.randomUUID(),
	linger: close => {
		const timer = setTimeout(close, READER_LINGER_MS)

		return () => {
			clearTimeout(timer)
		}
	}
}

interface OpenReader {
	readonly id: string
	readonly key: string
	readonly password: string | undefined
	refs: number
	closed: boolean
	cancelLinger: (() => void) | null
	unregister: () => void
	// A nested reader's hold on its parent's, let go when it closes.
	parent: ArchiveReaderRef | null
}

// By archive and client; within one, by password (in memory only, never logged).
const readers = new Map<string, Map<string | undefined, OpenReader>>()

function closeReader(open: OpenReader, deps: ArchiveReaderPageDeps): void {
	const byPassword = readers.get(open.key)

	if (byPassword?.get(open.password) !== open) {
		return
	}

	byPassword.delete(open.password)
	open.closed = true

	if (byPassword.size === 0) {
		readers.delete(open.key)
	}

	open.cancelLinger?.()
	open.cancelLinger = null
	open.unregister()
	deps.close(open.id)
	open.parent?.release()
}

// The registry key: by archive and client; a nested one under its parent's key and password (in memory only).
function readerKey(target: ReaderTarget): string {
	return target.nested === null
		? `${target.anon ? "anon" : "authed"}:${target.file.uuid}`
		: `${readerKey(target.nested.parent)}\u0000${target.nested.parentPassword ?? ""}\u0000${String(target.nested.index)}`
}

// The reader of `target` under `password`, opened (Comlink delivers calls in order, so its id is usable at once) or
// joined. A nested archive's holds its parent's reader open while it is.
export function acquireArchiveReader(
	target: ReaderTarget,
	password: string | undefined,
	deps: ArchiveReaderPageDeps = defaultArchiveReaderPageDeps
): ArchiveReaderRef {
	const { anon } = target
	const key = readerKey(target)
	let byPassword = readers.get(key)

	if (byPassword === undefined) {
		byPassword = new Map()
		readers.set(key, byPassword)
	}

	let open = byPassword.get(password)

	if (open === undefined) {
		const created: OpenReader = {
			id: deps.newId(),
			key,
			password,
			refs: 0,
			closed: false,
			cancelLinger: null,
			unregister: () => undefined,
			parent: null
		}

		created.unregister = registerPreviewDisposer("archiveReader", () => {
			created.unregister = () => undefined
			closeReader(created, deps)
		})
		byPassword.set(password, created)

		const nested = target.nested

		if (nested === null) {
			deps.open(created.id, target.file, anon, password)
		} else {
			created.parent = acquireArchiveReader(nested.parent, nested.parentPassword, deps)
			deps.openNested(
				created.id,
				created.parent.id,
				{ archive: nested.parent.uuid as ArchiveEntryId["archive"], index: nested.index },
				password
			)
		}
		open = created
	}

	const reader = open

	reader.refs += 1
	reader.cancelLinger?.()
	reader.cancelLinger = null

	let released = false

	return {
		id: reader.id,
		anon,
		password,
		isOpen: () => !reader.closed,
		release: () => {
			if (released) {
				return
			}

			released = true
			reader.refs -= 1

			if (reader.refs === 0) {
				const linger = (): void => {
					reader.cancelLinger = deps.linger(() => {
						reader.cancelLinger = null

						if (reader.refs === 0) {
							closeReader(reader, deps)
						}
					})
				}

				void deps.heldBytes(reader.id).then(held => {
					// Acquired again meanwhile, or closed: nothing to decide.
					if (reader.refs > 0 || reader.closed || reader.cancelLinger !== null) {
						return
					}

					if (held > READER_CLOSE_AT_ONCE_BYTES) {
						closeReader(reader, deps)
					} else {
						linger()
					}
				})
			}
		}
	}
}
