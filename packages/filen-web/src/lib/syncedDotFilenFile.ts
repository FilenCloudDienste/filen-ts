import type { File as SdkFile, SocketEvent } from "@filen/sdk-rs"
import { log } from "@/lib/log"

// One small JSON document of the user's, synced end-to-end encrypted as a file in a `.filen` directory (the
// drive encrypts every file): the spelling dictionary, the document-editing settings. Read once per session
// when first needed and again only after another session saved it (socket events); a change shows at once
// and is merged into the file as it stands before the upload, so devices and tabs never drop each other's
// changes. Unchanged state is never uploaded: every upload is a new file version. A read that fails is tried
// again with backoff while someone listens (and sooner after a reconnect), so a first read lost to a network
// blip never leaves the file unread for the session.

// For the upload the SDK binding makes: a small file is up well within it.
export const SYNCED_FILE_UPLOAD_DEADLINE_MS = 30_000
// Socket events arrive in bursts (a save is several): one reload after them.
const RELOAD_DELAY_MS = 500
// A read that failed is tried again while someone listens, after 5 s, then twice as long each time up to
// 5 min; a notice that the file may have changed (a reconnect) tries sooner, but never within 5 s of the
// last attempt.
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000

export interface SyncedFileSdk {
	// The directory, created when missing.
	officeDir: () => Promise<string>
	// The directory when it exists; creates nothing.
	findOfficeDir: () => Promise<string | null>
	knownOfficeDir: () => string | null
	noteSystemFile: (uuid: string) => void
	// `notBefore` (performance.now()): a listing that started earlier may miss a change the caller heard of
	// since; one started at or after it is as fresh as a new one (several files of one directory share it).
	listDirectory: (dirUuid: string, notBefore: number) => Promise<SdkFile[]>
	download: (file: SdkFile) => Promise<Uint8Array>
	upload: (parent: string, bytes: Uint8Array) => Promise<SdkFile>
}

// The document's format: what the file is called and how its text reads, merges and compares.
export interface SyncedFileCodec<Doc> {
	// Lower case; matched case-insensitively.
	readonly fileName: string
	// A larger file is not downloaded, and not overwritten.
	readonly maxBytes: number
	// Log scope.
	readonly scope: string
	empty: () => Doc
	// Throws for text that is not the format; `isNewerFormat` tells which errors mean "written by a newer
	// app" (the file is then read-only here).
	parse: (text: string) => Doc
	isNewerFormat: (error: unknown) => boolean
	serialize: (doc: Doc) => string
	merge: (a: Doc, b: Doc) => Doc
	same: (a: Doc, b: Doc) => boolean
}

type DriveSocketEvent = Extract<SocketEvent, { type: "drive" }>

// The file was written by a newer app (or is too large to read): a change can't be stored.
export class SyncedFileReadOnlyError extends Error {
	constructor(fileName: string) {
		super(`${fileName} was written by a newer version and is left unchanged`)
		this.name = "SyncedFileReadOnlyError"
	}
}

export class SyncedDotFilenFile<Doc> {
	private readonly sdk: SyncedFileSdk
	private readonly codec: SyncedFileCodec<Doc>
	private readonly listeners = new Set<(doc: Doc) => void>()
	private readonly onDoc: ((doc: Doc) => void) | undefined
	private doc: Doc
	// What the file held when last read or written; the local doc differs from it while a change waits.
	private synced: Doc
	private head: { uuid: string; parent: string } | null = null
	private loaded = false
	private stale = true
	// Bumped by every notice that the file may have changed, so one arriving during a read keeps it stale.
	private staleEpoch = 0
	// When the file was last heard to have changed (performance.now()): a listing must start after it.
	private staleSince = 0
	// The file was written by a newer app: it is read, never overwritten.
	private readOnly = false
	private readonly ownUuids = new Set<string>()
	private reading: Promise<void> | null = null
	private chain: Promise<void> = Promise.resolve()
	private reloadTimer: ReturnType<typeof setTimeout> | undefined
	private generation = 0
	// Someone asked for the file this session (load()): from then on it is kept fresh.
	private wanted = false
	// Reads failed in a row, and when the last read started (for the backoff).
	private failures = 0
	private attemptedAt = 0

	// `onDoc` hears every change before the listeners (a wrapper deriving its own view); unlike a listener it
	// does not keep the file fresh (a reload after another session saved happens only while someone listens).
	constructor(sdk: SyncedFileSdk, codec: SyncedFileCodec<Doc>, onDoc?: (doc: Doc) => void) {
		this.sdk = sdk
		this.codec = codec
		this.onDoc = onDoc
		this.doc = codec.empty()
		this.synced = codec.empty()
	}

	value(): Doc {
		return this.doc
	}

	// Whether this session read the file (or found none) since signing in.
	get isLoaded(): boolean {
		return this.loaded
	}

	// The file as last read or written: what is stored, unlike value() while a change waits for its upload.
	syncedValue(): Doc {
		return this.synced
	}

	// The last read found the file written by a newer app (or too large): it is never overwritten.
	get isReadOnly(): boolean {
		return this.readOnly
	}

	subscribe(listener: (doc: Doc) => void): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	// Reads the file when this session has not, or another session changed it since. A failure is tried again
	// later on its own while someone listens.
	load(): Promise<void> {
		if (this.loaded && !this.stale) return Promise.resolve()

		this.wanted = true

		if (this.reading === null) {
			const generation = this.generation

			this.attemptedAt = Date.now()
			this.reading = this.read().then(
				() => {
					this.failures = 0
				},
				(error: unknown) => {
					if (generation === this.generation) {
						this.failures++
						this.schedule(Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS))
					}

					throw error
				}
			)
			this.reading = this.reading.finally(() => {
				if (generation === this.generation) this.reading = null
			})
		}

		return this.reading
	}

	// One read `delay` ms from now (replacing one planned), only while someone listens then.
	private schedule(delay: number): void {
		clearTimeout(this.reloadTimer)
		this.reloadTimer = setTimeout(() => {
			if (this.listeners.size === 0) return

			this.load().catch((error: unknown) => {
				log.warn(this.codec.scope, "synced file reload failed", { error })
			})
		}, delay)
	}

	// Applies a change at once and uploads it (merged with the file as it stands); resolves once stored. With
	// `requireWritable`, a file this app can't overwrite rejects with SyncedFileReadOnlyError instead of keeping
	// the change local only (it is then not applied when the read already knew).
	change(edit: (doc: Doc) => Doc, options?: { requireWritable?: boolean }): Promise<void> {
		const requireWritable = options?.requireWritable === true

		if (requireWritable && this.loaded && this.readOnly) return Promise.reject(new SyncedFileReadOnlyError(this.codec.fileName))

		const next = edit(this.doc)

		if (next === this.doc) return Promise.resolve()

		this.setDoc(next)

		return this.enqueue(async () => {
			await this.flush()

			if (requireWritable && this.readOnly) throw new SyncedFileReadOnlyError(this.codec.fileName)
		})
	}

	// Uploads what still differs from the file (a change whose upload failed); resolves once stored. Rejects with
	// SyncedFileReadOnlyError, as change() with `requireWritable` does, when the file can't be overwritten.
	save(): Promise<void> {
		if (this.loaded && this.readOnly) return Promise.reject(new SyncedFileReadOnlyError(this.codec.fileName))

		return this.enqueue(async () => {
			await this.flush()

			if (this.readOnly) throw new SyncedFileReadOnlyError(this.codec.fileName)
		})
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.chain.then(task)

		// The chain continues past a failure; the caller still hears it.
		this.chain = run.catch(() => undefined)

		return run
	}

	private setDoc(doc: Doc): void {
		this.doc = doc
		this.onDoc?.(doc)

		for (const listener of [...this.listeners]) listener(doc)
	}

	private isFile(file: SdkFile): boolean {
		return file.meta.type === "decoded" && file.meta.data.name.toLowerCase() === this.codec.fileName
	}

	private async read(): Promise<void> {
		const codec = this.codec
		const generation = this.generation
		const epoch = this.staleEpoch
		const dir = await this.sdk.findOfficeDir()
		let remote = codec.empty()
		let head: { uuid: string; parent: string; timestamp: number } | null = null
		let readOnly = false

		if (dir !== null) {
			const files = (await this.sdk.listDirectory(dir, this.staleSince)).filter(file => this.isFile(file))

			// Normally one file; concurrent first saves can leave two, which merge.
			for (const file of files) {
				this.sdk.noteSystemFile(file.uuid)

				if (Number(file.size) > codec.maxBytes) {
					readOnly = true
					log.warn(codec.scope, "synced file too large to read", { uuid: file.uuid, size: Number(file.size) })

					continue
				}

				try {
					remote = codec.merge(remote, codec.parse(new TextDecoder().decode(await this.sdk.download(file))))
				} catch (error) {
					if (codec.isNewerFormat(error)) readOnly = true
					else if (!(error instanceof SyntaxError)) throw error

					log.warn(codec.scope, "synced file not read", { uuid: file.uuid, error })
				}

				const timestamp = Number(file.timestamp)

				if (head === null || timestamp > head.timestamp) head = { uuid: file.uuid, parent: file.parent, timestamp }
			}
		}

		// Signed out (or reset) meanwhile: this answer belongs to nobody.
		if (generation !== this.generation) return

		const firstRead = !this.loaded

		this.head = head === null ? null : { uuid: head.uuid, parent: head.parent }
		this.readOnly = readOnly
		this.synced = remote
		this.loaded = true
		// Read successfully: current unless another session saved during the read.
		this.stale = epoch !== this.staleEpoch

		const merged = codec.merge(this.doc, remote)

		// Listeners hear the first read even when it changed nothing (an unset setting is now known unset).
		if (!codec.same(merged, this.doc) || firstRead) this.setDoc(merged)

		// Changes made before this read (or while it ran) still have to reach the file.
		if (!codec.same(this.doc, remote)) void this.enqueue(() => this.flush()).catch(() => undefined)
	}

	private async flush(): Promise<void> {
		const generation = this.generation

		if (!this.loaded || this.stale) await this.load()
		if (generation !== this.generation || this.readOnly || this.codec.same(this.doc, this.synced)) return

		const doc = this.doc
		const parent = this.head?.parent ?? (await this.sdk.officeDir())
		const bytes = new TextEncoder().encode(this.codec.serialize(doc))
		const file = await this.sdk.upload(parent, bytes)

		if (generation !== this.generation) return

		this.ownUuids.add(file.uuid)
		this.sdk.noteSystemFile(file.uuid)
		this.head = { uuid: file.uuid, parent: file.parent }
		this.synced = doc
	}

	// Another session saved the file (or it went away): read it again, now when someone listens.
	handleDriveEvent(event: DriveSocketEvent): void {
		// Before anyone asked for the file there is nothing to keep fresh.
		if (!this.wanted) return

		const inner = event.inner

		switch (inner.type) {
			case "fileNew":
			case "fileRestore":
			case "fileMove":
			case "fileArchiveRestored": {
				const ours = inner.file.uuid === this.head?.uuid
				const inDir = inner.file.parent === (this.head?.parent ?? this.sdk.knownOfficeDir())

				if ((inDir && this.isFile(inner.file) && !this.ownUuids.has(inner.file.uuid)) || (ours && !inDir)) this.markStale()

				return
			}
			case "fileTrash":
			case "fileDeletedPermanent":
			case "fileMetadataChanged":
				if (inner.uuid === this.head?.uuid) this.markStale()

				return
			default:
				return
		}
	}

	// Events may have been missed (a socket gap, the directory forgotten), or a read failed while offline: read
	// again soon, when someone listens.
	markStale(): void {
		this.staleEpoch++
		this.staleSince = performance.now()
		this.stale = true

		if (!this.wanted || this.listeners.size === 0) return

		this.schedule(this.failures === 0 ? RELOAD_DELAY_MS : Math.max(RELOAD_DELAY_MS, this.attemptedAt + RETRY_BASE_MS - Date.now()))
	}

	// Sign-out: nothing of this account survives; work in flight answers no one.
	reset(): void {
		this.generation++
		clearTimeout(this.reloadTimer)
		this.wanted = false
		this.failures = 0
		this.loaded = false
		this.stale = true
		this.readOnly = false
		this.head = null
		this.synced = this.codec.empty()
		this.ownUuids.clear()
		this.reading = null
		this.chain = Promise.resolve()
		this.setDoc(this.codec.empty())
	}
}
