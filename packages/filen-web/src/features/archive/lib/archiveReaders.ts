import type { AnyFile } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { registerPreviewDisposer } from "@/lib/workers/previewDisposers"

// The page's side of the SDK worker's archive readers: one per archive, client and password, shared by every caller
// (the browser's listing, the entries it opens, a save, an iWork preview). Each acquire holds a reference; once the
// last is released the reader lingers a little, so a viewer closed and the next one opened (a page turn, a step back
// to the listing and into the next file) find the index and the decoder states it holds, then closes. Sign-out
// closes every one at once.

export const READER_LINGER_MS = 30_000

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
	close: (id: string) => void
	newId: () => string
	linger: (close: () => void) => () => void
}

export const defaultArchiveReaderPageDeps: ArchiveReaderPageDeps = {
	open: (id, file, anon, password) => {
		void sdkApi.openArchiveReader(id, file, anon, password)
	},
	close: id => {
		void sdkApi.closeArchiveReader(id)
	},
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
}

// The reader of `file` under `password`, opened (Comlink delivers calls in order, so its id is usable at once) or
// joined. `anon`: a public link's file, read through the public-link client.
export function acquireArchiveReader(
	file: AnyFile,
	anon: boolean,
	password: string | undefined,
	deps: ArchiveReaderPageDeps = defaultArchiveReaderPageDeps
): ArchiveReaderRef {
	const key = `${anon ? "anon" : "authed"}:${file.uuid}`
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
			unregister: () => undefined
		}

		created.unregister = registerPreviewDisposer("archiveReader", () => {
			created.unregister = () => undefined
			closeReader(created, deps)
		})
		byPassword.set(password, created)
		deps.open(created.id, file, anon, password)
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
				reader.cancelLinger = deps.linger(() => {
					reader.cancelLinger = null

					if (reader.refs === 0) {
						closeReader(reader, deps)
					}
				})
			}
		}
	}
}
