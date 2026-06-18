import * as FileSystem from "expo-file-system"
import { LOGS_DIRECTORY } from "@/lib/storageRoots"
import { redact } from "@/lib/logRedaction"

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

// Cap for the in-app log VIEWER (readEntries). Bounds parse cost + memory; the export bundles the
// full files regardless. 5000 newest entries is plenty for a diagnostic view and renders instantly
// in a virtualized list.
const MAX_VIEW_ENTRIES = 5000

type Entry = {
	t: number
	rank: number
	tag: string
	msg: string
	data: unknown
}

// A parsed, already-redacted log line as written to disk — the shape the in-app viewer reads back.
export type ReadLogEntry = {
	t: number
	l: LogLevel
	tag: string
	msg: string
	data?: unknown
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
	// Aggregate cap across rotated files (the active file lives on top of this, so the on-disk total
	// is roughly maxTotalBytes + maxFileBytes).
	maxTotalBytes: number
}

const DEFAULT_CONFIG: LoggerConfig = {
	// Dev/default. Production (bundled __DEV__ === false) narrows this to "warn" in the Logger
	// constructor — armed before the first line, with no dev-only window.
	minLevel: "debug",
	persistLevel: "warn",
	breadcrumbCapacity: 200,
	pendingMax: 50,
	flushDelayMs: 2000,
	// ~10 MB hard ceiling on disk: 9 MB of rotated 1 MB files + the active file. Cheap on device,
	// and with prod logs limited to warnings/errors this holds a long history.
	maxFileBytes: 1024 * 1024,
	maxTotalBytes: 9 * 1024 * 1024
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

	// Monotonic rotation counter — disambiguates rotated filenames so two rotations in the same
	// millisecond can't collide and silently overwrite each other.
	private rotationSeq: number = 0

	// Set by purge() (logout). Once disabled, no entry is captured and no flush writes — so a
	// console.* emitted during/after the logout wipe can't re-arm a flush and resurrect the logs
	// directory with decrypted-at-rest data. The post-logout reload instantiates a fresh, enabled
	// logger for the next session.
	private disabled: boolean = false

	// Dev-only sink (wired by the console polyfill) that mirrors DIRECT logger.* calls to the native
	// console so they're visible in Metro/devtools, not only on disk. Stays null in production (the
	// polyfill sets it under __DEV__ only) and in tests, so the hot path is just a null check. It uses
	// the console captured BEFORE the tee, so it can't recurse back through it. captureConsole() does
	// NOT use it — those came from console.* which the tee already mirrors in dev (avoids double-print).
	private devConsole: ((level: LogLevel, tag: string, msg: string, data?: unknown) => void) | null = null

	public constructor() {
		// Production (bundled __DEV__ === false): capture warn/error only — debug/info stay in-memory
		// breadcrumbs. Read at construction so it's correct in the app (where __DEV__ is defined) and
		// deterministic in tests (where __DEV__ is undefined → keeps the dev "debug" default).
		if ((globalThis as { __DEV__?: boolean }).__DEV__ === false) {
			this.config.minLevel = "warn"
			this.minRank = RANK["warn"]
		}
	}

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

	// Effective minimum captured level. The in-app viewer reads this to hide filter levels that can
	// never appear (prod = warn, so the Info/Debug filters would always be empty).
	public get minLevel(): LogLevel {
		return this.config.minLevel
	}

	// Wire the dev-only native-console mirror (see `devConsole`). Called once by the console polyfill,
	// under __DEV__ only — so in production this is never called and the mirror stays off.
	public setDevConsole(sink: ((level: LogLevel, tag: string, msg: string, data?: unknown) => void) | null): void {
		this.devConsole = sink
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
		// Terminal-disabled (post-logout) and below-threshold calls cost a compare + return, no alloc.
		if (this.disabled) {
			return
		}

		const rank = RANK[level]

		// HOT PATH gate — the cheapest possible check; gated calls cost a compare + return.
		if (rank < this.minRank) {
			return
		}

		// Dev DX: mirror DIRECT logger.* calls to the native console so they show up in Metro/devtools,
		// not only on disk. Null in production/tests (the polyfill only wires it under __DEV__) → just a
		// null check on the hot path. captureConsole() deliberately skips this (the tee already mirrors
		// console.* in dev), and the sink uses the pre-tee console so it can't recurse back through it.
		if (this.devConsole) {
			try {
				this.devConsole(level, tag, msg, data)
			} catch {
				// A log call must never throw.
			}
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
		if (this.disabled) {
			return
		}

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

		// Defer even the burst (pendingMax) flush off the calling frame via a 0ms timer, so the
		// synchronous file write never lands in the middle of the render/gesture that logged entry N.
		this.scheduleFlush(this.pending.length >= this.config.pendingMax ? 0 : this.config.flushDelayMs)
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
			const idx = (start + i) % capacity
			const entry = this.ring[idx]

			if (entry) {
				out.push(entry)
			}

			// Null the slot to release the held reference (so a logged object graph isn't retained
			// past the drain) WITHOUT reallocating the backing array.
			this.ring[idx] = undefined
		}

		this.ringHead = 0
		this.ringCount = 0

		return out
	}

	private scheduleFlush(delayMs: number = this.config.flushDelayMs): void {
		if (this.flushTimer !== null) {
			// A flush is already pending. Only re-arm if the new request is sooner (burst → immediate).
			if (delayMs >= this.config.flushDelayMs) {
				return
			}

			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}

		this.flushTimer = setTimeout(() => {
			this.flushTimer = null

			this.flushNow()
		}, delayMs)
	}

	public flushNow(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer)

			this.flushTimer = null
		}

		// Disabled (post-logout): never write. Release any buffered refs and bail.
		if (this.disabled) {
			this.pending = []

			return
		}

		if (this.pending.length === 0) {
			return
		}

		const batch = this.pending

		// Release the reference immediately so the held entries (and the object graphs they reference)
		// become collectable as soon as the batch is written — they are not retained past the flush.
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

		// Monotonic sequence disambiguates the filename so two rotations in the same millisecond can't
		// collide (which, with overwrite, would silently destroy a rotated file — worst exactly during
		// the error storm the logs are meant to capture).
		const rotated = new FileSystem.File(
			FileSystem.Paths.join(LOGS_DIRECTORY.uri, `log-${Date.now()}-${this.rotationSeq++}.ndjson`)
		)

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
		// Evict OLDEST rotated files first until the rotated total is within maxTotalBytes. Unlike the
		// file cache, no rotated file is "in use" (the active file is current.ndjson, excluded here), so
		// nothing is protected — maxTotalBytes is a true ceiling for rotated logs. Ordered by the
		// (timestamp, sequence) encoded in the filename, which is monotonic and collision-free (so ties
		// on a coarse mtime can't keep the wrong file).
		const rotated: { file: FileSystem.File; ts: number; seq: number; size: number }[] = []
		let total = 0

		for (const item of LOGS_DIRECTORY.list()) {
			if (!(item instanceof FileSystem.File) || item.name === CURRENT_FILE_NAME || !item.name.endsWith(".ndjson")) {
				continue
			}

			const match = /^log-(\d+)-(\d+)\.ndjson$/.exec(item.name)
			const size = item.size ?? 0

			total += size

			rotated.push({
				file: item,
				ts: match ? Number(match[1]) : 0,
				seq: match ? Number(match[2]) : 0,
				size
			})
		}

		if (total <= this.config.maxTotalBytes) {
			return
		}

		rotated.sort((a, b) => a.ts - b.ts || a.seq - b.seq)

		for (const entry of rotated) {
			if (total <= this.config.maxTotalBytes) {
				break
			}

			try {
				entry.file.delete()

				total -= entry.size
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

	// Log files ordered newest-first: the active file, then rotated files by descending (ts, seq).
	private logFilesNewestFirst(): FileSystem.File[] {
		const current: FileSystem.File[] = []
		const rotated: { file: FileSystem.File; ts: number; seq: number }[] = []

		for (const item of LOGS_DIRECTORY.list()) {
			if (!(item instanceof FileSystem.File) || !item.name.endsWith(".ndjson")) {
				continue
			}

			if (item.name === CURRENT_FILE_NAME) {
				current.push(item)

				continue
			}

			const match = /^log-(\d+)-(\d+)\.ndjson$/.exec(item.name)

			rotated.push({
				file: item,
				ts: match ? Number(match[1]) : 0,
				seq: match ? Number(match[2]) : 0
			})
		}

		rotated.sort((a, b) => b.ts - a.ts || b.seq - a.seq)

		return [...current, ...rotated.map(entry => entry.file)]
	}

	// Reads the persisted log lines back for the in-app viewer, newest-first, capped at `limit`.
	// Flushes pending entries first so the view reflects the latest state. Reads files newest-first
	// and walks each file's lines in reverse so it can stop at the cap without parsing everything;
	// malformed/torn lines are skipped. The lines are already redacted (redaction happens at write).
	public readEntries(limit: number = MAX_VIEW_ENTRIES): ReadLogEntry[] {
		if (this.disabled) {
			return []
		}

		this.flushNow()

		if (!LOGS_DIRECTORY.exists) {
			return []
		}

		const out: ReadLogEntry[] = []

		for (const file of this.logFilesNewestFirst()) {
			if (out.length >= limit) {
				break
			}

			let text: string

			try {
				text = file.textSync()
			} catch {
				continue
			}

			const lines = text.split("\n")

			for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
				const line = lines[i]

				if (!line) {
					continue
				}

				try {
					const parsed = JSON.parse(line) as ReadLogEntry

					if (parsed && typeof parsed.t === "number") {
						out.push(parsed)
					}
				} catch {
					// Skip a malformed / torn line (e.g. a partially-written final line).
				}
			}
		}

		// Strict newest-first across file boundaries (rotation order is chronological, but be exact).
		out.sort((a, b) => b.t - a.t)

		return out
	}

	// Wipe every on-disk log + in-memory buffer. Hooked into logout (decrypted-state wipe).
	public purge(): void {
		// Terminal: once purged (logout), capture + flush are disabled so a console.* during/after the
		// logout wipe can't re-arm a flush and re-create the logs directory with decrypted-at-rest data.
		this.disabled = true

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
