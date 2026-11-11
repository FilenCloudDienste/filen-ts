import { randomUUID } from "node:crypto"
import path from "node:path"
import type {
	DesktopDownloadItem,
	DesktopDragOutcome,
	DesktopDragPrepared,
	DesktopDragRefusal,
	DesktopDragState,
	DesktopTransferResult,
	DesktopTransferStart
} from "@filen/shared/desktop"
import { localName, type LocalPlatform } from "@filen/shared/localName"
import { LISTING_TTL_MS } from "../../shared/nativeProtocol.ts"
import type { DownloadSettle, DownloadWatch, TransfersService } from "../transfers/service.ts"
import { type DragEntry, planEntries, STAGED_LIMITS, WINDOWS_LIMITS } from "./plan.ts"
import type { DragTemp } from "./temp.ts"

// Drag-out sessions: the drive items one drag hands to the OS, from the page's prepare to the last byte the OS took.
// Every download runs through the transfers service (rows with origin "drag"). Three modes:
// - promise (macOS): Finder asks for each item at a URL it supplies; nothing is listed or downloaded before.
// - virtual (Windows): the trees are listed and planned at prepare; Explorer asks for each file's contents.
// - staged (Linux): the trees are downloaded into a temp directory before the OS drag can begin.
// A session answers only the webContents that prepared it; one not begun within UNBEGUN_TTL_MS ends.

export interface DragSessionEffects {
	transfers: Pick<TransfersService, "startDownload" | "startListedDownload" | "listTree" | "releaseTree" | "cancel">
	temp: DragTemp
	emit(state: DesktopDragState): void
	now(): number
	setTimer(run: () => void, ms: number): () => void
}

export type DragMode = "promise" | "virtual" | "staged"

// What the OS drag carries. promise: the items' local names; virtual: the planned entries; staged: the top-level paths.
export type DragPayload =
	| { mode: "promise"; items: { name: string; directory: boolean }[] }
	| { mode: "virtual"; entries: DragEntry[] }
	| { mode: "staged"; paths: string[] }

// An unbegun session ends this long after its prepare or the page's last begin attempt; a dropped promise drag waits
// this long for Finder's writes.
export const UNBEGUN_TTL_MS = 60_000

// Staged copies on Windows (Explorer copies them at the drop) are deleted this long after the drag; Linux file managers
// may link them instead, so there they stay until quit.
export const STAGED_KEEP_MS = 30 * 60_000

const STAGING_EMIT_MS = 250

type Phase = "preparing" | "staging" | "ready" | "begun" | "ended"

// One download a session runs; `id` once the service named it.
interface Download {
	id: string | null
	bytes: number
	done: boolean
}

// promise: one Finder write. virtual: one Explorer stream waiting on a file.
interface Ticket {
	download: Download | null
	cancelled: boolean
	finish(error: string | null): void
}

// A virtual entry's temp copy, shared by the tickets asking for it.
interface Fetch {
	path: string | null
	download: Download | null
	state: "running" | "done" | "failed"
	waiters: Map<number, (path: string | null) => void>
}

interface Session {
	id: string
	owner: number
	phase: Phase
	// The page holds the id: ended states are emitted.
	announced: boolean
	endedEmitted: boolean
	closed: boolean
	items: readonly DesktopDownloadItem[]
	listingId: string | null
	entries: DragEntry[]
	dir: string | null
	// A temp directory was asked for: deleted with the session.
	hasTemp: boolean
	downloads: Map<string, Download>
	pending: Set<Download>
	tickets: Map<number, Ticket>
	fetches: Map<number, Fetch>
	// staged
	files: number
	filesDone: number
	total: number
	lastEmit: number
	// promise: Finder's writes may still come; virtual: Explorer's operation may still run.
	lingering: boolean
	stopTimer: () => void
}

const NO_TIMER = () => undefined

const UNAVAILABLE = { refused: { reason: "unavailable" } } as const satisfies DesktopDragPrepared

function errorOf(settle: DownloadSettle): string | null {
	return settle.outcome === "done" ? null : (settle.error?.code ?? settle.outcome)
}

export class DragSessions {
	private readonly sessions = new Map<string, Session>()
	// The session whose OS drag runs now; one at a time (nested native loops can re-enter main's IPC).
	private running: string | null = null
	private readonly effects: DragSessionEffects
	private readonly platform: LocalPlatform
	private readonly mode: DragMode

	constructor(effects: DragSessionEffects, platform: LocalPlatform, mode: DragMode) {
		this.effects = effects
		this.platform = platform
		this.mode = mode
	}

	async prepare(owner: number, items: readonly DesktopDownloadItem[]): Promise<DesktopDragPrepared> {
		for (const session of [...this.sessions.values()]) {
			if (session.owner === owner && this.unbegun(session)) {
				this.end(session, "cancelled", "now")
			}
		}

		if (this.mode === "staged") {
			const refusal = stagedPrecheck(items)

			if (refusal !== null) {
				return { refused: refusal }
			}
		}

		const session = this.open(owner, items)

		if (this.mode === "promise") {
			return this.announce(session, "ready")
		}

		const limits = this.mode === "virtual" ? WINDOWS_LIMITS : STAGED_LIMITS
		const listingId = randomUUID()
		const listed = await this.effects.transfers.listTree({ listingId, items, maxEntries: limits.maxEntries })

		if (session.closed) {
			this.effects.transfers.releaseTree(listingId)

			return UNAVAILABLE
		}

		if (!listed.ok) {
			this.close(session, "keep")

			return UNAVAILABLE
		}

		if ("tooMany" in listed.value) {
			this.close(session, "keep")

			return { refused: { reason: "tooMany", entries: listed.value.tooMany, limit: limits.maxEntries } }
		}

		session.listingId = listingId

		const plan = planEntries(listed.value.entries, limits, this.platform)

		if ("refused" in plan) {
			this.close(session, "keep")

			return plan
		}

		session.entries = plan.entries

		return this.mode === "virtual" ? this.announce(session, "ready") : this.stage(session)
	}

	beginnable(owner: number, id: string): "ready" | "notReady" | "unknown" {
		const session = this.owned(owner, id)

		if (session === null || !this.unbegun(session)) {
			return "unknown"
		}

		// The page is still trying: the session lives on.
		this.arm(session, UNBEGUN_TTL_MS, () => {
			this.end(session, "cancelled", "now")
		})

		return session.phase === "ready" ? "ready" : "notReady"
	}

	payload(owner: number, id: string): DragPayload | null {
		const session = this.owned(owner, id)

		if (session === null) {
			return null
		}

		if (this.mode === "promise") {
			return {
				mode: "promise",
				items: session.items.map(item => ({ name: localName(item.name, "darwin"), directory: item.kind === "directory" }))
			}
		}

		if (this.mode === "virtual") {
			return { mode: "virtual", entries: session.entries }
		}

		const dir = session.dir ?? ""

		return {
			mode: "staged",
			paths: session.entries.filter(entry => isTopLevel(entry)).map(entry => path.join(dir, entry.relativePath))
		}
	}

	// Set before the native call: a second begin while one runs (re-entered from a nested loop) is refused.
	markBegun(id: string): boolean {
		const session = this.sessions.get(id)

		if (this.running !== null || session === undefined || session.phase !== "ready") {
			return false
		}

		session.phase = "begun"
		session.stopTimer()
		session.stopTimer = NO_TIMER
		this.running = id

		return true
	}

	nativeDragRunning(): boolean {
		return this.running !== null
	}

	promise(
		id: string,
		ticket: number,
		index: number,
		target: string,
		onProgress: (bytes: number, size: number) => void,
		onTemp: (path: string) => void,
		onDone: (error: string | null) => void
	): void {
		const session = this.sessions.get(id)
		const item = session?.items[index]

		if (session === undefined || session.closed || item === undefined || this.mode !== "promise" || session.tickets.has(ticket)) {
			onDone("unknown")

			return
		}

		const entry = this.ticket(session, ticket, onDone)
		const download = this.download(session)

		entry.download = download

		this.track(
			session,
			download,
			this.effects.transfers.startDownload({
				items: [item],
				destination: { kind: "exact", path: target, conflict: "replace" },
				origin: "drag",
				revealable: false,
				watch: {
					onProgress: (_id, bytes, size) => {
						onProgress(bytes, size)
					},
					onTemp: (_id, temp) => {
						onTemp(temp)
					},
					onSettled: settle => {
						this.settled(session, download, settle)
						entry.finish(errorOf(settle))
					}
				}
			}),
			error => {
				entry.finish(error)
			}
		)
	}

	contents(id: string, ticket: number, index: number, onDone: (path: string | null) => void): void {
		const session = this.sessions.get(id)
		const entry = session?.entries[index]

		if (session === undefined || session.closed || entry === undefined || entry.directory || this.mode !== "virtual") {
			onDone(null)

			return
		}

		const fetch = session.fetches.get(index) ?? this.fetch(session, index)

		if (fetch.state === "running") {
			// The stream's answer comes through the fetch; the ticket only marks it open.
			const open = this.ticket(session, ticket, () => undefined)

			fetch.waiters.set(ticket, file => {
				open.finish(null)
				onDone(file)
			})
		} else {
			onDone(fetch.state === "done" ? fetch.path : null)
		}

		// One file ahead: Explorer reads the entries in order.
		for (let next = index + 1; next < session.entries.length; next++) {
			if (session.entries[next]?.directory === false) {
				if (!session.fetches.has(next)) {
					this.fetch(session, next)
				}

				break
			}
		}
	}

	cancelTicket(id: string, ticket: number): void {
		const session = this.sessions.get(id)
		const entry = session?.tickets.get(ticket)

		if (session === undefined || entry === undefined) {
			return
		}

		entry.cancelled = true

		if (this.mode === "virtual") {
			for (const [index, fetch] of session.fetches) {
				const waiter = fetch.waiters.get(ticket)

				if (waiter === undefined) {
					continue
				}

				fetch.waiters.delete(ticket)

				// Nobody else reads it: stop it, and start over if asked again.
				if (fetch.waiters.size === 0 && fetch.state === "running") {
					session.fetches.delete(index)
					this.cancelDownloads(fetch.download === null ? [] : [fetch.download])
				}

				waiter(null)
			}

			return
		}

		// Finished once the cancelled download settles.
		this.cancelDownloads(entry.download === null ? [] : [entry.download])
	}

	// The OS drag finished. Staged: done. Promise: Finder's writes may still come after a drop. Virtual: Explorer
	// extracts after a drop until operationEnded.
	ended(id: string, outcome: DesktopDragOutcome): void {
		if (this.running === id) {
			this.running = null
		}

		const session = this.sessions.get(id)

		if (session === undefined || session.closed) {
			return
		}

		session.phase = "ended"
		this.emitEnded(session, outcome)

		if (this.mode === "staged") {
			this.close(session, this.platform === "win32" ? "later" : "keep")

			return
		}

		if (outcome !== "dropped") {
			this.linger(session, 0)

			return
		}

		this.linger(session, this.mode === "promise" ? UNBEGUN_TTL_MS : LISTING_TTL_MS)
	}

	// Windows: Explorer's async operation ended; every stream still waiting fails.
	operationEnded(id: string): void {
		const session = this.sessions.get(id)

		if (session !== undefined && this.mode === "virtual") {
			this.close(session, "now")
		}
	}

	release(owner: number, id: string): void {
		const session = this.owned(owner, id)

		if (session !== null && this.unbegun(session)) {
			this.end(session, "cancelled", "now")
		}
	}

	// The page is gone (destroyed, crashed, navigated): its unbegun sessions end. A begun drag is the OS's to end.
	ownerGone(owner: number): void {
		for (const session of [...this.sessions.values()]) {
			if (session.owner === owner && this.unbegun(session)) {
				this.end(session, "cancelled", "now")
			}
		}
	}

	// Quit: temp removal waits for removeAllSync, once the host stopped writing. Sign-out: removed now.
	abortAll(reason: "quit" | "signedOut"): void {
		this.running = null

		for (const session of [...this.sessions.values()]) {
			this.end(session, "cancelled", reason === "quit" ? "keep" : "now", reason)
		}
	}

	// Sessions holding a listing, tickets or downloads: the host stays up while this is above 0.
	live(): number {
		let count = 0

		for (const session of this.sessions.values()) {
			if (session.listingId !== null || session.tickets.size > 0 || session.pending.size > 0) {
				count++
			}
		}

		return count
	}

	private open(owner: number, items: readonly DesktopDownloadItem[]): Session {
		const session: Session = {
			id: randomUUID(),
			owner,
			phase: "preparing",
			announced: false,
			endedEmitted: false,
			closed: false,
			items: [...items],
			listingId: null,
			entries: [],
			dir: null,
			hasTemp: false,
			downloads: new Map(),
			pending: new Set(),
			tickets: new Map(),
			fetches: new Map(),
			files: 0,
			filesDone: 0,
			total: 0,
			lastEmit: 0,
			lingering: false,
			stopTimer: NO_TIMER
		}

		this.sessions.set(session.id, session)
		this.arm(session, UNBEGUN_TTL_MS, () => {
			this.end(session, "cancelled", "now")
		})

		return session
	}

	private announce(session: Session, phase: "ready"): DesktopDragPrepared {
		session.phase = phase
		session.announced = true
		this.effects.emit({ id: session.id, state: "ready" })

		return { id: session.id }
	}

	private async stage(session: Session): Promise<DesktopDragPrepared> {
		session.hasTemp = true

		try {
			session.dir = await this.effects.temp.sessionDir(session.id)
			await this.effects.temp.makeDirectories(
				session.id,
				session.entries.filter(entry => entry.directory).map(entry => entry.relativePath)
			)
		} catch {
			this.close(session, "now")

			return UNAVAILABLE
		}

		if (session.closed) {
			return UNAVAILABLE
		}

		const dir = session.dir
		const files = session.entries.filter(entry => !entry.directory)

		session.files = files.length
		session.total = files.reduce((sum, entry) => sum + entry.size, 0)

		if (files.length === 0) {
			this.stagedReady(session)

			return this.announce(session, "ready")
		}

		session.phase = "staging"
		session.announced = true
		session.lastEmit = this.effects.now()
		this.effects.emit({ id: session.id, state: "staging", bytes: 0, total: session.total })

		const watch: DownloadWatch = {
			onProgress: (id, bytes) => {
				const download = this.known(session, id)

				download.bytes = bytes

				const now = this.effects.now()

				if (session.phase === "staging" && now - session.lastEmit >= STAGING_EMIT_MS) {
					session.lastEmit = now

					let sum = 0

					for (const each of session.downloads.values()) {
						sum += each.bytes
					}

					this.effects.emit({ id: session.id, state: "staging", bytes: sum, total: session.total })
				}
			},
			onSettled: settle => {
				const download = this.known(session, settle.id)

				this.settled(session, download, settle)

				if (session.closed) {
					return
				}

				if (settle.outcome !== "done") {
					this.end(session, "failed", "now")

					return
				}

				session.filesDone++

				if (session.filesDone === session.files) {
					this.stagedReady(session)
				}
			}
		}
		const failed = () => {
			this.end(session, "failed", "now")
		}
		const listed = files.filter(entry => entry.listIndex !== null)

		for (const entry of files) {
			const item = entry.listIndex === null ? session.items[entry.source] : undefined

			if (item !== undefined) {
				this.trackMany(
					session,
					this.effects.transfers.startDownload({
						items: [item],
						destination: { kind: "exact", path: path.join(dir ?? "", entry.relativePath), conflict: "replace" },
						origin: "drag",
						revealable: false,
						watch
					}),
					failed
				)
			}
		}

		if (listed.length > 0 && session.listingId !== null) {
			this.trackMany(
				session,
				this.effects.transfers.startListedDownload({
					listingId: session.listingId,
					entries: listed.map(entry => ({
						index: entry.listIndex ?? 0,
						path: path.join(dir ?? "", entry.relativePath),
						name: path.basename(entry.relativePath),
						size: entry.size
					})),
					watch
				}),
				failed
			)
		}

		return { id: session.id }
	}

	// Every file is on disk: the listing is no longer needed.
	private stagedReady(session: Session): void {
		session.phase = "ready"
		this.releaseListing(session)

		if (session.announced) {
			this.effects.emit({ id: session.id, state: "ready" })
		}
	}

	private fetch(session: Session, index: number): Fetch {
		const fetch: Fetch = { path: null, download: null, state: "running", waiters: new Map() }
		const entry = session.entries[index]

		session.fetches.set(index, fetch)

		if (entry === undefined) {
			return fetch
		}

		const download = this.download(session)
		const finish = (file: string | null) => {
			if (fetch.state !== "running") {
				return
			}

			fetch.state = file === null ? "failed" : "done"

			const waiters = [...fetch.waiters.values()]

			fetch.waiters.clear()

			for (const waiter of waiters) {
				waiter(file)
			}
		}

		fetch.download = download
		session.hasTemp = true

		const watch: DownloadWatch = {
			onSettled: settle => {
				this.settled(session, download, settle)
				finish(settle.outcome === "done" ? fetch.path : null)
			}
		}
		const start = async (): Promise<DesktopTransferResult<DesktopTransferStart>> => {
			fetch.path = path.join(await this.effects.temp.sessionDir(session.id), String(index))

			if (session.closed) {
				return { ok: false, error: { code: "unknown" } }
			}

			const item = entry.listIndex === null ? session.items[entry.source] : undefined

			if (item !== undefined) {
				return this.effects.transfers.startDownload({
					items: [item],
					destination: { kind: "exact", path: fetch.path, conflict: "replace" },
					origin: "drag",
					revealable: false,
					watch
				})
			}

			if (entry.listIndex === null || session.listingId === null) {
				return { ok: false, error: { code: "invalidItem" } }
			}

			return this.effects.transfers.startListedDownload({
				listingId: session.listingId,
				entries: [{ index: entry.listIndex, path: fetch.path, name: path.basename(entry.relativePath), size: entry.size }],
				watch
			})
		}

		this.track(session, download, start(), () => {
			finish(null)
		})

		return fetch
	}

	private ticket(session: Session, ticket: number, onDone: (error: string | null) => void): Ticket {
		let finished = false
		const entry: Ticket = {
			download: null,
			cancelled: false,
			finish: error => {
				if (finished) {
					return
				}

				finished = true
				session.tickets.delete(ticket)
				onDone(error)
				this.maybeClose(session)
			}
		}

		session.tickets.set(ticket, entry)

		return entry
	}

	private download(session: Session): Download {
		const download: Download = { id: null, bytes: 0, done: false }

		session.pending.add(download)

		return download
	}

	// A download the service named in a watch call before its start answered (or one of a batch start).
	private known(session: Session, id: string): Download {
		let download = session.downloads.get(id)

		if (download === undefined) {
			download = { id, bytes: 0, done: false }
			session.downloads.set(id, download)
			session.pending.add(download)
		}

		return download
	}

	private settled(session: Session, download: Download, settle: DownloadSettle): void {
		download.done = true
		download.id ??= settle.id
		session.pending.delete(download)
	}

	// One download's start: its id recorded, cancelled at once if the session or ticket ended meanwhile.
	private track(
		session: Session,
		download: Download,
		started: Promise<DesktopTransferResult<DesktopTransferStart>>,
		failed: (error: string) => void
	): void {
		void started.then(
			result => {
				if (!result.ok || result.value.status !== "started") {
					download.done = true
					session.pending.delete(download)
					failed(result.ok ? "cancelled" : result.error.code)

					return
				}

				const [id] = result.value.ids

				download.id ??= id ?? null

				if (download.id !== null && !download.done) {
					session.downloads.set(download.id, download)

					const ticket = [...session.tickets.values()].find(each => each.download === download)

					if (session.closed || ticket?.cancelled === true) {
						this.cancelDownloads([download])
					}
				}
			},
			(error: unknown) => {
				download.done = true
				session.pending.delete(download)
				failed(error instanceof Error ? error.message : "unknown")
			}
		)
	}

	// A batch start whose downloads report through one watch.
	private trackMany(session: Session, started: Promise<DesktopTransferResult<DesktopTransferStart>>, failed: () => void): void {
		void started.then(
			result => {
				if (!result.ok || result.value.status !== "started") {
					failed()

					return
				}

				for (const id of result.value.ids) {
					const download = this.known(session, id)

					if (session.closed && !download.done) {
						this.cancelDownloads([download])
					}
				}
			},
			() => {
				failed()
			}
		)
	}

	private cancelDownloads(downloads: readonly Download[]): void {
		const ids = downloads.flatMap(download => (download.id === null || download.done ? [] : [download.id]))

		if (ids.length > 0) {
			this.effects.transfers.cancel(ids)
		}
	}

	private owned(owner: number, id: string): Session | null {
		const session = this.sessions.get(id)

		return session === undefined || session.owner !== owner || session.closed ? null : session
	}

	private unbegun(session: Session): boolean {
		return session.phase === "preparing" || session.phase === "staging" || session.phase === "ready"
	}

	private arm(session: Session, ms: number, run: () => void): void {
		session.stopTimer()
		session.stopTimer = this.effects.setTimer(run, ms)
	}

	private emitEnded(session: Session, outcome: DesktopDragOutcome): void {
		if (session.announced && !session.endedEmitted) {
			session.endedEmitted = true
			this.effects.emit({ id: session.id, state: "ended", outcome })
		}
	}

	private end(session: Session, outcome: DesktopDragOutcome, temp: "now" | "keep", error = "cancelled"): void {
		if (this.running === session.id) {
			this.running = null
		}

		session.phase = "ended"
		this.emitEnded(session, outcome)
		this.close(session, temp, error)
	}

	// After the drag: closes once `ms` passed and no ticket is open (promise), or at operationEnded (virtual).
	private linger(session: Session, ms: number): void {
		if (ms === 0) {
			session.lingering = false
			this.close(session, "now")

			return
		}

		session.lingering = true
		this.arm(session, ms, () => {
			session.lingering = false

			if (this.mode === "virtual") {
				this.close(session, "now")
			} else {
				this.maybeClose(session)
			}
		})
	}

	// A promise session whose drag ended closes with its last ticket, once Finder had its time to ask.
	private maybeClose(session: Session): void {
		if (this.mode === "promise" && session.phase === "ended" && !session.lingering && session.tickets.size === 0) {
			this.close(session, "keep")
		}
	}

	private releaseListing(session: Session): void {
		if (session.listingId !== null) {
			this.effects.transfers.releaseTree(session.listingId)
			session.listingId = null
		}
	}

	// Frees everything the session holds: downloads cancelled, tickets failed, listing released, temp as asked.
	private close(session: Session, temp: "now" | "later" | "keep", error = "cancelled"): void {
		if (session.closed) {
			return
		}

		session.closed = true
		session.stopTimer()
		session.stopTimer = NO_TIMER
		this.sessions.delete(session.id)
		this.cancelDownloads([...session.pending])

		for (const ticket of [...session.tickets.values()]) {
			ticket.finish(error)
		}

		for (const fetch of session.fetches.values()) {
			for (const waiter of fetch.waiters.values()) {
				waiter(null)
			}

			fetch.waiters.clear()
		}

		this.releaseListing(session)

		if (!session.hasTemp || temp === "keep") {
			return
		}

		if (temp === "later") {
			this.effects.temp.deleteLater(session.id, STAGED_KEEP_MS)
		} else {
			void this.effects.temp.deleteNow(session.id)
		}
	}
}

function isTopLevel(entry: DragEntry): boolean {
	return !entry.relativePath.includes("/") && !entry.relativePath.includes("\\")
}

// A staged drag refused from the page's own items, before any listing: more items than entries allowed, or top-level
// files already past the byte cap (a directory's size is learnt from its listing).
function stagedPrecheck(items: readonly DesktopDownloadItem[]): DesktopDragRefusal | null {
	if (items.length > STAGED_LIMITS.maxEntries) {
		return { reason: "tooMany", entries: items.length, limit: STAGED_LIMITS.maxEntries }
	}

	let bytes = 0

	for (const item of items) {
		if (item.kind === "file") {
			bytes += item.size
		}
	}

	return STAGED_LIMITS.maxBytes !== null && bytes > STAGED_LIMITS.maxBytes
		? { reason: "tooLarge", bytes, limit: STAGED_LIMITS.maxBytes }
		: null
}
