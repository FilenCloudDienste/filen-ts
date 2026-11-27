import type { Note, NoteType } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { storage, isMissingStorageMethod } from "@/lib/storage/adapter"
import type { StorageApi } from "@/workers/db.worker"
import type { NoteIndexRow } from "@/workers/noteIndex"
import { createListenerSet } from "@/lib/listenerSet"
import { log } from "@/lib/log"
import {
	buildNoteMatchQuery,
	noteIndexIsStale,
	noteIndexText,
	noteSearchCandidates,
	type NoteSearchHits
} from "@/features/notes/lib/searchIndex.logic"

// The notes full-text index: decrypted note text in the origin's private OPFS database (workers/noteIndex.ts), so
// a search reads only the bodies that changed since they were indexed. The owner chose this trade-off: the text is
// wiped with the database on sign-out (performLogout), and rows of another account are never read.
//
// Every tab calls through its storage handle, so the leader's db worker runs every write. The text comes from reads
// made anyway (the editor's content query, the outbox's pushes, socket edits); a search reads the rest. Note text
// is never logged.

export interface NoteIndexDeps {
	api: () => Promise<StorageApi>
	// A stable id of the signed-in account.
	account: () => Promise<string>
	// The note's content, undefined when it does not decrypt.
	readContent: (note: Note) => Promise<string | undefined>
}

export interface IndexedNote {
	uuid: string
	editedTimestamp: bigint
	noteType: NoteType
}

export class NoteSearchIndex {
	private closed = false
	private accountId: Promise<string> | null = null
	// The newest text this page wrote per note, so the same read landing twice is written once.
	private readonly written = new Map<string, bigint>()
	private readonly changes = createListenerSet<readonly { uuid: string; edited: bigint }[]>("notes.searchIndex")

	private readonly deps: NoteIndexDeps

	public constructor(deps: NoteIndexDeps) {
		this.deps = deps
	}

	public readonly onChange = this.changes.subscribe

	private account(): Promise<string> {
		if (this.accountId === null) {
			// Never throws synchronously, so the handle read beside it always has its rejection handled.
			const attempt = Promise.resolve().then(() => this.deps.account())

			this.accountId = attempt
			void attempt.catch(() => {
				if (this.accountId === attempt) {
					this.accountId = null
				}
			})
		}

		return this.accountId
	}

	// Null when the index cannot serve (signed out, or a leader on an older build without it).
	private async call<T>(run: (api: StorageApi, account: string) => Promise<T>): Promise<T | null> {
		if (this.closed) {
			return null
		}

		const [api, account] = await Promise.all([this.deps.api(), this.account()])

		// Closed meanwhile: sign-out began while the handle resolved.
		if (this.isClosed()) {
			return null
		}

		try {
			return await run(api, account)
		} catch (e) {
			if (isMissingStorageMethod(e)) {
				return null
			}

			throw e
		}
	}

	// A note's content as read elsewhere, at the note's editedTimestamp as listed when the read began.
	public record(note: IndexedNote, content: string): void {
		if (this.closed || (this.written.get(note.uuid) ?? -1n) >= note.editedTimestamp) {
			return
		}

		let text: string

		try {
			text = noteIndexText(note.noteType, content)
		} catch (e) {
			log.warn("notes.searchIndex", "could not extract text", note.uuid, e)

			return
		}

		this.written.set(note.uuid, note.editedTimestamp)

		const row: NoteIndexRow = { uuid: note.uuid, edited: String(note.editedTimestamp), text }

		void this.put([row]).catch((e: unknown) => {
			log.warn("notes.searchIndex", "index write failed", note.uuid, e)
		})
	}

	public async put(rows: NoteIndexRow[]): Promise<boolean> {
		if (rows.length === 0) {
			return true
		}

		const done = await this.call(async (api, account) => {
			await api.noteIndexPut(account, rows)

			return true
		})

		if (done === true) {
			this.changes.emit(rows.map(row => ({ uuid: row.uuid, edited: BigInt(row.edited) })))
		}

		return done === true
	}

	// Notes deleted, left or no longer shared.
	public remove(uuids: string[]): void {
		for (const uuid of uuids) {
			this.written.delete(uuid)
		}

		void this.call(async (api, account) => {
			await api.noteIndexDelete(account, uuids)
		})
			.then(() => {
				this.changes.emit([])
			})
			.catch((e: unknown) => {
				log.warn("notes.searchIndex", "index delete failed", e)
			})
	}

	public async stamps(): Promise<Map<string, bigint> | null> {
		const rows = await this.call((api, account) => api.noteIndexStamps(account))

		return rows === null ? null : new Map(rows.map(([uuid, edited]) => [uuid, BigInt(edited)]))
	}

	public async prune(keep: string[]): Promise<void> {
		await this.call((api, account) => api.noteIndexPrune(account, keep))
	}

	public search(match: string, limit: number): Promise<[string, string][] | null> {
		return this.call((api, account) => api.noteIndexSearch(account, match, limit))
	}

	// One body read for the index; null when the content does not decrypt.
	public async read(note: Note): Promise<NoteIndexRow | null> {
		const content = await this.deps.readContent(note)

		if (content === undefined) {
			return null
		}

		this.written.set(note.uuid, note.editedTimestamp)

		return { uuid: note.uuid, edited: String(note.editedTimestamp), text: noteIndexText(note.noteType, content) }
	}

	public isClosed(): boolean {
		return this.closed
	}

	// Sign-out: no write may land after the wipe.
	public close(): void {
		this.closed = true
		this.changes.clear()
	}
}

export const noteSearchIndex = new NoteSearchIndex({
	api: async () => (await storage()).api,
	// The root directory's uuid: fixed for the account's lifetime and held by the client.
	account: () => sdkApi.videoIndexAccount(),
	readContent: note => sdkApi.getNoteContent(note)
})

export interface NoteSearchState {
	hits: NoteSearchHits
	// Candidate bodies still being read: a search with no rows may yet match one of them.
	pending: number
	// Candidate bodies that were not searched: the read failed, the device is offline, or the index is unavailable.
	failed: number
}

const EMPTY_HITS: NoteSearchHits = { body: new Map(), indexed: new Set() }
const EMPTY_STATE: NoteSearchState = { hits: EMPTY_HITS, pending: 0, failed: 0 }

// Body reads per batch: each batch is one index write and one fresh query, so results stream in.
const READ_BATCH = 8
const RESULT_LIMIT = 1000

// One search box's view of the index. While its key is non-empty it reads the candidates (title misses) whose
// indexed text is missing or older than the list, a batch at a time, and re-queries as rows land. A blank key stops
// it: nothing is read outside a search.
export class NoteSearchSession {
	private notes: readonly Note[] = []
	private key = ""
	private online = true
	private active = false
	private stamps: Map<string, bigint> | null = null
	private loading: Promise<void> | null = null
	private unavailable = false
	private generation = 0
	// Notes whose read failed in this search, at the editedTimestamp it failed at.
	private readonly failedAt = new Map<string, bigint>()
	private readonly queued = new Map<string, Note>()
	private readonly reading = new Set<string>()
	private draining = false
	private body: NoteSearchHits["body"] = new Map()
	private bodyKey = ""
	private querying = false
	private requery = false
	private hits: NoteSearchHits = EMPTY_HITS
	private indexed: ReadonlySet<string> = new Set()
	private state: NoteSearchState = EMPTY_STATE
	private readonly listeners = createListenerSet("notes.searchSession")
	private unsubscribeIndex: (() => void) | null = null

	private readonly index: NoteSearchIndex

	public constructor(index: NoteSearchIndex) {
		this.index = index
	}

	public readonly subscribe = (listener: () => void): (() => void) => this.listeners.subscribe(listener)

	public readonly getState = (): NoteSearchState => this.state

	public update(notes: readonly Note[], key: string, online: boolean): void {
		if (key.length === 0) {
			this.stop()

			return
		}

		const keyChanged = key !== this.key

		if (this.active && notes === this.notes && !keyChanged && online === this.online) {
			return
		}

		this.notes = notes
		this.key = key
		this.online = online

		if (!this.active) {
			this.start()

			return
		}

		this.refresh()

		if (keyChanged) {
			this.query()
		}
	}

	private start(): void {
		this.active = true

		const generation = ++this.generation

		this.unsubscribeIndex = this.index.onChange(changes => {
			if (changes.length > 0 && this.stamps !== null) {
				for (const change of changes) {
					this.stamps.set(change.uuid, maxStamp(this.stamps.get(change.uuid), change.edited))
				}

				this.indexed = new Set(this.stamps.keys())
			}

			this.refresh()
			this.query()
		})

		this.loading = (async () => {
			try {
				const stamps = await this.index.stamps()

				if (generation !== this.generation) {
					return
				}

				if (stamps === null) {
					this.unavailable = true
				} else {
					const listed = new Set<string>(this.notes.map(note => note.uuid))

					// Rows of notes no longer listed go; the rest is what this search builds on.
					for (const uuid of stamps.keys()) {
						if (!listed.has(uuid)) {
							stamps.delete(uuid)
						}
					}

					this.stamps = stamps
					this.indexed = new Set(stamps.keys())

					// An empty list is one not read yet, never a reason to drop the index.
					if (listed.size > 0) {
						await this.index.prune([...listed])
					}
				}
			} catch (e) {
				log.warn("notes.searchIndex", "index unavailable", e)

				if (generation === this.generation) {
					this.unavailable = true
				}
			} finally {
				if (generation === this.generation) {
					this.loading = null
					this.refresh()
					this.query()
				}
			}
		})()

		this.publish()
	}

	public stop(): void {
		if (!this.active) {
			return
		}

		this.active = false
		this.generation++
		this.unsubscribeIndex?.()
		this.unsubscribeIndex = null
		this.key = ""
		this.notes = []
		this.stamps = null
		this.loading = null
		this.unavailable = false
		this.failedAt.clear()
		this.queued.clear()
		this.body = new Map()
		this.bodyKey = ""
		this.indexed = new Set()
		this.publish()
	}

	private refresh(): void {
		if (!this.active || this.stamps === null) {
			this.publish()

			return
		}

		// Only what this key needs is read: a narrower key drops what it no longer needs.
		this.queued.clear()

		if (this.online) {
			for (const note of noteSearchCandidates(this.notes, this.key)) {
				if (
					noteIndexIsStale(note, this.stamps.get(note.uuid)) &&
					this.failedAt.get(note.uuid) !== note.editedTimestamp &&
					!this.reading.has(note.uuid)
				) {
					this.queued.set(note.uuid, note)
				}
			}

			void this.drain()
		}

		this.publish()
	}

	private async drain(): Promise<void> {
		if (this.draining) {
			return
		}

		this.draining = true

		try {
			while (this.active && this.queued.size > 0) {
				const generation = this.generation
				const batch = [...this.queued.values()].slice(0, READ_BATCH)

				for (const note of batch) {
					this.queued.delete(note.uuid)
					this.reading.add(note.uuid)
				}

				this.publish()

				const reads = await Promise.allSettled(batch.map(note => this.index.read(note)))
				const rows: NoteIndexRow[] = []

				reads.forEach((read, i) => {
					const note = batch[i]

					if (note === undefined) {
						return
					}

					if (read.status === "fulfilled" && read.value !== null) {
						rows.push(read.value)
					} else if (generation === this.generation) {
						this.failedAt.set(note.uuid, note.editedTimestamp)
					}
				})

				let stored = false

				try {
					// Written even when the search was cleared meanwhile: the reads were made.
					stored = await this.index.put(rows)
				} catch (e) {
					log.warn("notes.searchIndex", "index write failed", e)
				}

				for (const note of batch) {
					this.reading.delete(note.uuid)
				}

				if (!stored && generation === this.generation) {
					for (const row of rows) {
						const note = batch.find(candidate => candidate.uuid === row.uuid)

						if (note !== undefined) {
							this.failedAt.set(note.uuid, note.editedTimestamp)
						}
					}
				}

				this.publish()
			}
		} finally {
			this.draining = false
		}
	}

	private query(): void {
		if (!this.active || this.loading !== null) {
			return
		}

		if (this.querying) {
			this.requery = true

			return
		}

		const key = this.key
		const generation = this.generation
		const match = buildNoteMatchQuery(key)

		if (match === null || this.unavailable) {
			this.setBody(new Map(), key)

			return
		}

		this.querying = true

		void this.index
			.search(match, RESULT_LIMIT)
			.then(
				rows => {
					if (generation === this.generation && key === this.key) {
						this.setBody(new Map((rows ?? []).map(([uuid, snippet], rank) => [uuid, { rank, snippet }])), key)
					}
				},
				(e: unknown) => {
					log.warn("notes.searchIndex", "index query failed", e)
				}
			)
			.finally(() => {
				this.querying = false

				if (this.requery || (generation === this.generation && key !== this.key)) {
					this.requery = false
					this.query()
				}
			})
	}

	private setBody(body: NoteSearchHits["body"], key: string): void {
		this.body = body
		this.bodyKey = key
		this.publish()
	}

	private publish(): void {
		let pending = 0
		let failed = 0

		if (this.active) {
			const stamps = this.stamps

			for (const note of noteSearchCandidates(this.notes, this.key)) {
				if (this.unavailable) {
					failed++
				} else if (stamps === null || this.queued.has(note.uuid) || this.reading.has(note.uuid)) {
					pending++
				} else if (noteIndexIsStale(note, stamps.get(note.uuid))) {
					failed++
				}
			}

			// A key whose query has not answered yet counts as still searching when nothing else is.
			if (pending === 0 && failed === 0 && this.bodyKey !== this.key && !this.unavailable) {
				pending = 1
			}
		}

		const body = this.bodyKey === this.key ? this.body : EMPTY_HITS.body

		if (this.hits.body !== body || this.hits.indexed !== this.indexed) {
			this.hits = { body, indexed: this.indexed }
		}

		if (this.state.hits === this.hits && this.state.pending === pending && this.state.failed === failed) {
			return
		}

		this.state = { hits: this.hits, pending, failed }
		this.listeners.emit()
	}
}

function maxStamp(a: bigint | undefined, b: bigint): bigint {
	return a === undefined || b > a ? b : a
}

// What a search with no rows tells the user: still reading bodies, some bodies could not be searched,
// or a real "no results".
export type NoteSearchEmptyState = "searching" | "unsearched" | "empty"

export function noteSearchEmptyState({ pending, failed }: Pick<NoteSearchState, "pending" | "failed">): NoteSearchEmptyState {
	if (pending > 0) {
		return "searching"
	}

	return failed > 0 ? "unsearched" : "empty"
}
