import * as FileSystem from "expo-file-system"
import { LOGS_DIRECTORY } from "@/lib/storageRoots"
import { redact } from "@/lib/logRedaction"
import { planSizeCapEviction } from "@/lib/cacheEviction"

// Async, non-blocking, privacy-aware on-disk diagnostic logger.
//
// Design goals (jan): prod builds must never notice it. The HOT PATH (a log call) is a single
// numeric level-gate followed by, at most, one cheap push — NO serialization, NO redaction, NO
// I/O. Everything expensive (redaction, JSON encoding, file append, rotation) happens off the hot
// path at flush time, batched and infrequent. Sub-threshold calls (e.g. log.debug in prod) cost a
// compare-and-return with zero allocation.
//
// Capture model (errors + warnings + a breadcrumb ring): warn/error (and uncaught errors /
// rejections, wired separately) are persisted; info/debug only live in a bounded in-memory ring
// and are written to disk solely as context dragged in front of a persisted error.
//
// A log call MUST NEVER throw — logging can't be allowed to break the app (or recurse through the
// console tee), so every public entry point and the flush are fully guarded.

export type LogLevel = "debug" | "info" | "warn" | "error"

const RANK: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
}

const LEVEL_NAME: Record<number, LogLevel> = {
	10: "debug",
	20: "info",
	30: "warn",
	40: "error"
}

const CURRENT_FILE_NAME = "current.ndjson"

type Entry = {
	t: number
	rank: number
	tag: string
	msg: string
	data: unknown
}

export type LoggerConfig = {
	// Calls below this level are dropped entirely (cheapest possible gate).
	minLevel: LogLevel
	// Calls at/above this level are persisted to disk and drag the breadcrumb ring with them.
	persistLevel: LogLevel
	// Fixed in-memory ring capacity for sub-persist breadcrumbs (overwrite-oldest, no growth).
	breadcrumbCapacity: number
	// Flush immediately once this many entries are pending (burst protection).
	pendingMax: number
	// Debounce window before a scheduled flush; batches writes so disk I/O is infrequent.
	flushDelayMs: number
	// Rotate the active file once it grows past this.
	maxFileBytes: number
	// Aggregate cap across rotated files (the active file is always kept on top).
	maxTotalBytes: number
}

const DEFAULT_CONFIG: LoggerConfig = {
	minLevel: "debug",
	persistLevel: "warn",
	breadcrumbCapacity: 200,
	pendingMax: 50,
	flushDelayMs: 2000,
	maxFileBytes: 512 * 1024,
	maxTotalBytes: 4 * 1024 * 1024
}

export class Logger {
	private config: LoggerConfig = {
		...DEFAULT_CONFIG
	}

	private minRank: number = RANK[DEFAULT_CONFIG.minLevel]
	private persistRank: number = RANK[DEFAULT_CONFIG.persistLevel]

	// Circular breadcrumb ring — O(1) push, no allocation growth.
	private ring: (Entry | undefined)[] = new Array<Entry | undefined>(DEFAULT_CONFIG.breadcrumbCapacity)
	private ringHead: number = 0
	private ringCount: number = 0

	private pending: Entry[] = []
	private flushTimer: ReturnType<typeof setTimeout> | null = null
	private directoryReady: boolean = false

	public configure(opts: Partial<LoggerConfig>): void {
		this.config = {
			...this.config,
			...opts
		}

		this.minRank = RANK[this.config.minLevel]
		this.persistRank = RANK[this.config.persistLevel]

		if (this.ring.length !== this.config.breadcrumbCapacity) {
			this.ring = new Array<Entry | undefined>(this.config.breadcrumbCapacity)
			this.ringHead = 0
			this.ringCount = 0
		}
	}

	public debug(tag: string, msg: string, data?: unknown): void {
		this.log("debug", tag, msg, data)
	}

	public info(tag: string, msg: string, data?: unknown): void {
		this.log("info", tag, msg, data)
	}

	public warn(tag: string, msg: string, data?: unknown): void {
		this.log("warn", tag, msg, data)
	}

	public error(tag: string, msg: string, data?: unknown): void {
		this.log("error", tag, msg, data)
	}

	public log(level: LogLevel, tag: string, msg: string, data?: unknown): void {
		const rank = RANK[level]

		// HOT PATH gate — the cheapest possible check; gated calls cost a compare + return.
		if (rank < this.minRank) {
			return
		}

		try {
			this.enqueue({
				t: Date.now(),
				rank,
				tag,
				msg,
				data
			})
		} catch {
			// Logging must never throw.
		}
	}

	// Used by the console tee (capture wiring) to record a raw console.* call.
	public captureConsole(level: LogLevel, args: unknown[]): void {
		const rank = RANK[level]

		if (rank < this.minRank) {
			return
		}

		try {
			const firstIsString = typeof args[0] === "string"

			this.enqueue({
				t: Date.now(),
				rank,
				tag: "console",
				msg: firstIsString ? (args[0] as string) : "",
				data: firstIsString ? (args.length > 1 ? args.slice(1) : undefined) : args
			})
		} catch {
			// Logging must never throw.
		}
	}

	private enqueue(entry: Entry): void {
		if (entry.rank < this.persistRank) {
			this.pushBreadcrumb(entry)

			return
		}

		// Persisted entry: drag the recent breadcrumbs in front of it for context, then itself.
		const crumbs = this.drainBreadcrumbs()

		for (let i = 0; i < crumbs.length; i++) {
			this.pending.push(crumbs[i] as Entry)
		}

		this.pending.push(entry)

		if (this.pending.length >= this.config.pendingMax) {
			this.flushNow()

			return
		}

		this.scheduleFlush()
	}

	private pushBreadcrumb(entry: Entry): void {
		const capacity = this.ring.length

		if (capacity === 0) {
			return
		}

		this.ring[this.ringHead] = entry
		this.ringHead = (this.ringHead + 1) % capacity

		if (this.ringCount < capacity) {
			this.ringCount++
		}
	}

	private drainBreadcrumbs(): Entry[] {
		if (this.ringCount === 0) {
			return []
		}

		const capacity = this.ring.length
		const out: Entry[] = []
		const start = this.ringCount < capacity ? 0 : this.ringHead

		for (let i = 0; i < this.ringCount; i++) {
			const entry = this.ring[(start + i) % capacity]

			if (entry) {
				out.push(entry)
			}
		}

		this.ring = new Array<Entry | undefined>(capacity)
		this.ringHead = 0
		this.ringCount = 0

		return out
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== null) {
			return
		}

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null

			this.flushNow()
		}, this.config.flushDelayMs)
	}

	public flushNow(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer)

			this.flushTimer = null
		}

		if (this.pending.length === 0) {
			return
		}

		const batch = this.pending

		this.pending = []

		try {
			this.writeBatch(batch)
		} catch {
			// A failed write must never break the app; the batch is simply dropped.
		}
	}

	private ensureDirectory(): void {
		if (this.directoryReady) {
			return
		}

		if (!LOGS_DIRECTORY.exists) {
			LOGS_DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		}

		this.directoryReady = true
	}

	private entryToLine(entry: Entry): string {
		try {
			const redacted = redact({
				msg: entry.msg,
				data: entry.data
			}) as {
				msg: string
				data?: unknown
			}

			const record: Record<string, unknown> = {
				t: entry.t,
				l: LEVEL_NAME[entry.rank],
				tag: entry.tag,
				msg: redacted.msg
			}

			if (redacted.data !== undefined) {
				record["data"] = redacted.data
			}

			return `${JSON.stringify(record)}\n`
		} catch {
			return `${JSON.stringify({
				t: entry.t,
				l: LEVEL_NAME[entry.rank],
				tag: entry.tag,
				msg: "[unserializable]"
			})}\n`
		}
	}

	private writeBatch(batch: Entry[]): void {
		this.ensureDirectory()

		let text = ""

		for (let i = 0; i < batch.length; i++) {
			text += this.entryToLine(batch[i] as Entry)
		}

		const file = new FileSystem.File(FileSystem.Paths.join(LOGS_DIRECTORY.uri, CURRENT_FILE_NAME))

		if (!file.exists) {
			file.create({
				intermediates: true
			})
		}

		// Single batched append. Off the hot path and infrequent; isolated here so the primitive
		// (currently write({append}); could become a FileHandle / native async writer) can be swapped.
		file.write(text, {
			append: true
		})

		this.rotateIfNeeded(file)
	}

	private rotateIfNeeded(current: FileSystem.File): void {
		if ((current.size ?? 0) < this.config.maxFileBytes) {
			return
		}

		const rotated = new FileSystem.File(FileSystem.Paths.join(LOGS_DIRECTORY.uri, `log-${Date.now()}.ndjson`))

		try {
			current.move(rotated, {
				overwrite: true
			})
		} catch {
			return
		}

		this.pruneOldFiles()
	}

	private pruneOldFiles(): void {
		const byUri = new Map<string, FileSystem.File>()
		const entries: { key: string; cachedAt: number; size: number }[] = []

		for (const item of LOGS_DIRECTORY.list()) {
			if (!(item instanceof FileSystem.File)) {
				continue
			}

			// Never evict the active file — that's where the next entries land.
			if (item.name === CURRENT_FILE_NAME) {
				continue
			}

			byUri.set(item.uri, item)

			entries.push({
				key: item.uri,
				cachedAt: item.lastModified ?? 0,
				size: item.size ?? 0
			})
		}

		for (const uri of planSizeCapEviction(entries, this.config.maxTotalBytes)) {
			try {
				byUri.get(uri)?.delete()
			} catch {
				// Best-effort cleanup.
			}
		}
	}

	// All on-disk log files (for export). Caller flushes first if it wants pending entries included.
	public listLogFiles(): FileSystem.File[] {
		if (!LOGS_DIRECTORY.exists) {
			return []
		}

		const files: FileSystem.File[] = []

		for (const item of LOGS_DIRECTORY.list()) {
			if (item instanceof FileSystem.File && item.name.endsWith(".ndjson")) {
				files.push(item)
			}
		}

		return files
	}

	// Wipe every on-disk log + in-memory buffer. Hooked into logout (decrypted-state wipe).
	public purge(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer)

			this.flushTimer = null
		}

		this.pending = []

		this.drainBreadcrumbs()

		try {
			if (LOGS_DIRECTORY.exists) {
				LOGS_DIRECTORY.delete()
			}
		} catch {
			// Best-effort.
		}

		this.directoryReady = false
	}
}

const logger = new Logger()

export default logger
