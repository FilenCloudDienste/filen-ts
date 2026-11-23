import * as Comlink from "comlink"
import type { ArchiveEntry, ArchiveFormat, ListUpdate, PasswordCheck } from "@filen/sdk-rs"
import { ENTRY_KIND, listedPathOf, type EntryKindCode } from "@/lib/sdk/archiveListing"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { ArchiveNameInfo, ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import { archiveNameInfo, cachedArchiveNameInfo } from "@/features/drive/lib/archiveHelpers"
import { AUTO_LIST_DELAY_MS, gateFor } from "@/features/archive/lib/archiveGate.logic"
import { isArchivePasswordError, summaryOf } from "@/features/archive/lib/archiveBrowser.logic"
import { comicFormatOfName, isZipPackageName } from "@/features/drive/lib/archiveFormats"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { createEntryStore, type EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingCache } from "@/features/archive/lib/listingCache"
import { acquireArchiveReader, type ArchiveReaderRef } from "@/features/archive/lib/archiveReaders"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { openByteReader } from "@/features/preview/lib/origin/byteReader"
import { log } from "@/lib/log"
import { settleGuard } from "@/lib/workers/settleGuard"

// One archive's listing for the browser: which phase it is in, and the entries read so far. Each run is a
// job of its own id, through the archive's reader for the run's password (archiveReaders.ts); the session holds the
// reader of the password it accepted, so the entries the browser opens read from the index the listing left.

export type ListingPhase =
	| { type: "resolving" }
	| { type: "gate"; format: ArchiveFormat | null }
	| { type: "starting" }
	// Another archive job holds the page's slot.
	| { type: "waiting" }
	| {
			type: "reading"
			bytesRead: number
			archiveBytes: number
			entries: number
			bytesPerSecond: number | null
			etaMs: number | null
			member: ReadingMember | null
	  }
	// Nothing could be listed without a password (a 7z whose index is encrypted).
	| { type: "needsPassword"; wrong: boolean }
	| { type: "done"; summary: ListSummary }
	// The user stopped it; the entries read until then stay.
	| { type: "stopped"; summary: ListSummary }
	// The entries read before the failure stay (a damaged tar); no summary when the call itself was refused.
	| { type: "failed"; error: ErrorDTO; summary: ListSummary | null }

// The member a compressed tar's listing is decoding, before it is listed (ListUpdate.reading): shown apart from the
// store, never selectable, until a batch lists it or an update names another or none.
export interface ReadingMember {
	// Its ArchiveEntryId.index.
	index: number
	// As a row names it: the last segment of its extracted path, the whole stored path for a pathless one.
	name: string
	// Its directory, "/"-joined ("" the root).
	parentPath: string
	kind: EntryKindCode
}

export interface ListTotalsN {
	entries: number
	dirs: number
	files: number
	bytes: number
	skipped: number
	bytesSkipped: number
}

export interface ListSummary {
	format: ArchiveFormat | null
	password: PasswordCheck
	totals: ListTotalsN
	// Entries listed that never reached the page.
	undelivered: number
	duplicates: { names: string[]; count: number } | null
	unaccountedBytes: number
	// A password is being checked against the entries already shown.
	verifying: boolean
	// That check waits for another archive job to free the page's slot.
	verifyWaiting: boolean
	// Why the last check could not tell (other than the password being wrong).
	verifyError: ErrorDTO | null
}

export interface ListingSnapshot {
	phase: ListingPhase
	store: EntryStore
	// Changes with every notification; the store's own version also changes between them.
	version: number
	// What the archive's name says; null until known.
	info: ArchiveNameInfo | null
}

export interface ListingDeps {
	acquireReader: (target: ArchiveSource, password: string | undefined) => ArchiveReaderRef
	listArchive: (readerId: string, id: string, params: ListJobParams, onEvent: (event: ListJobEvent) => void) => Promise<ListReportDTO>
	cancel: (id: string) => void
	release: (id: string) => void
	newId: () => string
	// Resolves when the time is up or the signal aborts, whichever comes first.
	delay: (ms: number, signal: AbortSignal) => Promise<void>
	nameInfo: (name: string) => ArchiveNameInfo | Promise<ArchiveNameInfo>
	// What the archive's first bytes say it is, where only a zip's or 7z's magic matters (archiveHeadFormat); absent:
	// the name decides.
	headFormat?: (source: ArchiveSource, signal: AbortSignal) => Promise<ArchiveFormat | null>
}

// The format a zip's or 7z's magic names; null for any other head.
export function headMagicFormat(head: Uint8Array): ArchiveFormat | null {
	const starts = (magic: readonly number[]): boolean => magic.every((byte, i) => head[i] === byte)

	if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06])) {
		return { type: "zip" }
	}

	return starts([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ? { type: "sevenZ" } : null
}

const HEAD_MAGIC_BYTES = 8

// The archive's first bytes, read through the client its source is read through, as a format (headMagicFormat).
async function archiveHeadFormat(source: ArchiveSource, signal: AbortSignal): Promise<ArchiveFormat | null> {
	const origin: ByteOrigin = source.anon ? { kind: "linkedFile", file: source.file } : { kind: "file", file: source.file }
	const reader = await openByteReader(origin, crypto.randomUUID(), { access: source.anon ? "anon" : "authed", blocks: 1 })

	try {
		return headMagicFormat(await reader.read(0, HEAD_MAGIC_BYTES, signal))
	} finally {
		reader.close()
	}
}

export interface ListingSession {
	getSnapshot: () => ListingSnapshot
	subscribe: (listener: () => void) => () => void
	// Lists a gated archive, or one waiting out the auto-start delay, now.
	start: () => void
	stop: () => void
	submitPassword: (password: string) => void
	// Lists again from scratch, with the password already accepted.
	retry: () => void
	// The password the listing accepted. In memory only: never logged, never stored.
	password: () => string | undefined
	// One an entry's own preview or download proved right: later extracts and entries take it unasked.
	acceptPassword: (password: string) => void
	// The user accepted reading a solid block's earlier files to reach an entry: later entries of this session open
	// unasked, each still bounded by its own listed skip.
	costAccepted: () => boolean
	acceptCost: () => void
	// Where the browser is, "" the root: a cached listing reopens there.
	rememberDirPath: (path: string) => void
	restoredDirPath: () => string
	// Stops a running listing (its job is released once it settled) and caches a completed one.
	dispose: () => void
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms)

		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{
				once: true
			}
		)
	})
}

export const defaultListingDeps: ListingDeps = {
	acquireReader: (target, password) => acquireArchiveReader(target, password),
	listArchive: (readerId, id, params, onEvent) => sdkApi.listArchiveReader(readerId, id, params, Comlink.proxy(onEvent)),
	cancel: id => {
		void sdkApi.cancelTransfer(id)
	},
	release: id => {
		void sdkApi.releaseJob(id)
	},
	newId: () => crypto.randomUUID(),
	delay: abortableDelay,
	nameInfo: name => cachedArchiveNameInfo(name) ?? archiveNameInfo(name),
	headFormat: archiveHeadFormat
}

export function listSummaryOf(report: ListReportDTO): ListSummary {
	const totals = report.totals

	return {
		format: report.format ?? null,
		password: report.password,
		totals: {
			entries: Number(totals.entries),
			dirs: Number(totals.dirs),
			files: Number(totals.files),
			bytes: Number(totals.bytes),
			skipped: Number(totals.skipped),
			bytesSkipped: Number(totals.bytesSkipped)
		},
		undelivered: Number(report.undeliveredEntries),
		duplicates: report.duplicates === undefined ? null : { names: report.duplicates.names, count: Number(report.duplicates.count) },
		unaccountedBytes: Number(report.unaccountedBytes),
		verifying: false,
		verifyWaiting: false,
		verifyError: null
	}
}

function readingMemberOf(entry: ArchiveEntry, previous: ReadingMember | null): ReadingMember {
	// Sent with every update while it is read: the one already held is kept.
	if (previous?.index === entry.id.index) {
		return previous
	}

	const path = listedPathOf(entry)
	const slash = path.lastIndexOf("/")

	return {
		index: entry.id.index,
		name: path === "" ? entry.storedPath : path.slice(slash + 1),
		parentPath: slash < 0 ? "" : path.slice(0, slash),
		kind: ENTRY_KIND[entry.kind.type]
	}
}

function readingPhase(update: ListUpdate, previous: ReadingMember | null): ListingPhase {
	return {
		type: "reading",
		bytesRead: Number(update.bytesRead),
		archiveBytes: Number(update.archiveBytes),
		entries: Number(update.entries),
		bytesPerSecond: update.bytesPerSecond === undefined ? null : Number(update.bytesPerSecond),
		etaMs: update.etaMs === undefined ? null : Number(update.etaMs),
		member: update.reading === undefined ? null : readingMemberOf(update.reading, previous)
	}
}

function readingMember(phase: ListingPhase): ReadingMember | null {
	return phase.type === "reading" ? phase.member : null
}

function withSummary(phase: ListingPhase, summary: ListSummary): ListingPhase {
	switch (phase.type) {
		case "done":
		case "stopped":
		case "failed":
			return { ...phase, summary }
		default:
			return phase
	}
}

// A full run lists into a fresh store; a verify run checks a password against what is shown, its entries
// left undelivered.
interface Run {
	id: string
	reader: ArchiveReaderRef
	token: number
	kind: "full" | "verify"
	store: EntryStore
	// Archive bytes the run read, as its last update said.
	bytesRead: number
}

// `cache` is the host's (listingCache.ts): a completed listing reopens from it, and goes into it on dispose.
export function openListingSession(
	source: ArchiveSource,
	deps: ListingDeps = defaultListingDeps,
	cache: ListingCache | null = null
): ListingSession {
	const listeners = new Set<() => void>()
	const cached = cache?.get(source.uuid)
	let snapshot: ListingSnapshot =
		cached === undefined
			? { phase: { type: "resolving" }, store: createEntryStore(), version: 0, info: null }
			: { phase: { type: "done", summary: cached.summary }, store: cached.store, version: 0, info: null }
	let accepted = cached?.password
	let dirPath = cached?.lastDirPath ?? ""
	// Bumped by every run and by dispose: an event or a settle of an older run is dropped.
	let token = 0
	let run: Run | null = null
	let pendingStart: AbortController | null = null
	// The head read that tells a renamed zip from a RAR, before the gate.
	let headRead: AbortController | null = null
	let disposed = false
	let costAccepted = cached?.costAccepted ?? false
	// The reader of the accepted password, which the browser's entries read through. Nothing is read until used.
	let held: ArchiveReaderRef = deps.acquireReader(source, accepted)

	// The session reads through the accepted password's reader from now on.
	const holdAccepted = (): void => {
		if (disposed || held.password === accepted) {
			return
		}

		const previous = held

		held = deps.acquireReader(source, accepted)
		previous.release()
	}

	const publish = (next: Omit<ListingSnapshot, "version">): void => {
		if (disposed) {
			return
		}

		snapshot = { ...next, version: snapshot.version + 1 }

		for (const listener of listeners) {
			listener()
		}
	}

	const setPhase = (phase: ListingPhase, store: EntryStore = snapshot.store): void => {
		publish({ phase, store, info: snapshot.info })
	}

	const isCurrent = (current: Run): boolean => !disposed && current.token === token

	const setVerifyWaiting = (waiting: boolean): void => {
		const summary = summaryOf(snapshot.phase)

		if (summary !== null && summary.verifying && summary.verifyWaiting !== waiting) {
			setPhase(withSummary(snapshot.phase, { ...summary, verifyWaiting: waiting }))
		}
	}

	const settleFull = (current: Run, report: ListReportDTO, password: string | undefined): void => {
		const summary = listSummaryOf(report)
		const error = report.error

		if (error === undefined) {
			if (password !== undefined && (report.password === "right" || report.password === "unchecked")) {
				accepted = password
			}

			setPhase({ type: "done", summary }, current.store)
		} else if (error.kind === "Cancelled") {
			// Stopped before anything was read (while waiting for the slot, say): as if never started. A compressed tar's
			// member stopped mid-read is listed all the same; a stop after some bytes yet before any member's header keeps
			// the stop, which says nothing was listed yet.
			setPhase(
				current.store.entryCount === 0 && current.bytesRead === 0
					? { type: "gate", format: report.format ?? snapshot.info?.format ?? null }
					: { type: "stopped", summary },
				current.store
			)
		} else if (isArchivePasswordError(error)) {
			setPhase({ type: "needsPassword", wrong: error.kind === "ArchiveWrongPassword" || password !== undefined }, current.store)
		} else {
			setPhase({ type: "failed", error, summary }, current.store)
		}
	}

	const settleVerify = (report: ListReportDTO | null, error: ErrorDTO | null, password: string): void => {
		const summary = summaryOf(snapshot.phase)

		if (summary === null) {
			return
		}

		const failure = error ?? report?.error ?? null
		const check = failure === null ? (report?.password ?? "wrong") : "wrong"
		let next: ListSummary

		if (failure !== null && !isArchivePasswordError(failure)) {
			// A stop or a dropped connection says nothing about the password.
			next = { ...summary, verifying: false, verifyWaiting: false, verifyError: failure.kind === "Cancelled" ? null : failure }
		} else if (check === "right" || check === "unchecked") {
			accepted = password
			next = { ...summary, password: check, verifying: false, verifyWaiting: false, verifyError: null }
		} else {
			next = { ...summary, password: "wrong", verifying: false, verifyWaiting: false, verifyError: null }
		}

		setPhase(withSummary(snapshot.phase, next))
	}

	const execute = async (current: Run, password: string | undefined): Promise<void> => {
		// An event that arrives after the report would append its entries a second time, or show the run reading again.
		const events = settleGuard((event: ListJobEvent): void => {
			if (!isCurrent(current)) {
				return
			}

			// A verify run's entries are already shown; it tells only whether it waits for the slot.
			if (current.kind === "verify") {
				if (event.type === "update") {
					setVerifyWaiting(event.update.phase === "waitingForWorker")
				}

				return
			}

			const phase = snapshot.phase
			const member = readingMember(phase)

			if (event.type === "entries") {
				// Appended unannounced: the next update tells, at most every 200 ms. A batch listing the member being read
				// announces it at once, the member's row giving way to its entry.
				current.store.append(event.batch)

				if (phase.type === "reading" && member !== null && event.batch.index.includes(member.index)) {
					setPhase({ ...phase, member: null })
				}

				return
			}

			switch (event.update.phase) {
				case "waitingForWorker":
					setPhase({ type: "waiting" })

					break
				case "reading":
					current.bytesRead = Number(event.update.bytesRead)
					setPhase(readingPhase(event.update, member))

					break
				default:
					// The last update names no member.
					if (phase.type === "reading" && member !== null) {
						setPhase({ ...phase, member: null })
					}

					break
			}
		})

		try {
			const report = await deps
				.listArchive(
					current.reader.id,
					current.id,
					{ keepReportEntries: false, deliverEntries: current.kind === "full" },
					events.callback
				)
				.finally(events.settle)

			if (!isCurrent(current)) {
				return
			}

			run = null

			if (current.kind === "verify" && password !== undefined) {
				settleVerify(report, null, password)
			} else {
				settleFull(current, report, password)
			}
		} catch (e) {
			if (!isCurrent(current)) {
				return
			}

			run = null

			const error = asErrorDTO(e)

			if (current.kind === "verify" && password !== undefined) {
				settleVerify(null, error, password)
			} else if (isArchivePasswordError(error)) {
				// The reader's opening refused it: a 7z or RAR whose index is encrypted.
				setPhase({ type: "needsPassword", wrong: error.kind === "ArchiveWrongPassword" || password !== undefined }, current.store)
			} else {
				setPhase({ type: "failed", error, summary: null })
			}
		} finally {
			// Only once the call settled: a released id would orphan a run still winding down.
			deps.release(current.id)
			holdAccepted()
			current.reader.release()
		}
	}

	const begin = (kind: Run["kind"], password: string | undefined): void => {
		pendingStart?.abort()
		pendingStart = null

		token += 1

		const current: Run = {
			id: deps.newId(),
			reader: deps.acquireReader(source, password),
			token,
			kind,
			store: kind === "full" ? createEntryStore() : snapshot.store,
			bytesRead: 0
		}

		run = current

		if (kind === "full") {
			// A fresh store: the browser starts over at its root.
			dirPath = ""
			setPhase({ type: "starting" }, current.store)
		} else {
			const summary = summaryOf(snapshot.phase)

			if (summary !== null) {
				setPhase(withSummary(snapshot.phase, { ...summary, verifying: true, verifyWaiting: false, verifyError: null }))
			}
		}

		void execute(current, password)
	}

	const scheduleStart = (): void => {
		const controller = new AbortController()

		pendingStart = controller
		setPhase({ type: "starting" })

		void deps.delay(AUTO_LIST_DELAY_MS, controller.signal).then(() => {
			if (controller.signal.aborted || disposed) {
				return
			}

			pendingStart = null
			begin("full", accepted)
		})
	}

	const applyInfo = (info: ArchiveNameInfo): void => {
		publish({ phase: snapshot.phase, store: snapshot.store, info })

		if (snapshot.phase.type !== "resolving") {
			return
		}

		const named = info.format ?? comicFormatOfName(source.name)

		if (gateFor(named, source.size, isZipPackageName(source.name)) !== "gate") {
			scheduleStart()

			return
		}

		// A RAR's gate is for its member walk: a zip or 7z named .cbr or .rar (a renamed comic) lists from its index at
		// once. Its head tells, one read of its first chunk, made only for a RAR name above the gate, and only of a drive or
		// link file: an archive held in another has no file of its own to read it from.
		if (named?.type !== "rar" || deps.headFormat === undefined || source.nested !== null) {
			setPhase({ type: "gate", format: info.format })

			return
		}

		const controller = new AbortController()

		headRead = controller
		void deps
			.headFormat(source, controller.signal)
			.then(
				format => format,
				(e: unknown) => {
					log.warn("listingSession", "reading an archive's head failed", e)

					return null
				}
			)
			.then(format => {
				if (headRead !== controller || controller.signal.aborted || disposed || snapshot.phase.type !== "resolving") {
					return
				}

				headRead = null

				if (format !== null && gateFor(format, source.size, false) === "list") {
					scheduleStart()
				} else {
					setPhase({ type: "gate", format: info.format })
				}
			})
	}

	const resolveInfo = (): void => {
		let answer: ArchiveNameInfo | Promise<ArchiveNameInfo>

		try {
			answer = deps.nameInfo(source.name)
		} catch (e) {
			setPhase({ type: "failed", error: asErrorDTO(e), summary: null })

			return
		}

		if (!(answer instanceof Promise)) {
			applyInfo(answer)

			return
		}

		if (snapshot.phase.type !== "resolving" && summaryOf(snapshot.phase) === null) {
			setPhase({ type: "resolving" })
		}

		answer.then(
			info => {
				applyInfo(info)
			},
			(e: unknown) => {
				if (snapshot.phase.type === "resolving") {
					setPhase({ type: "failed", error: asErrorDTO(e), summary: null })
				}
			}
		)
	}

	resolveInfo()

	return {
		getSnapshot: () => snapshot,
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		start: () => {
			if (disposed || run !== null) {
				return
			}

			if (pendingStart !== null || snapshot.phase.type === "gate") {
				begin("full", accepted)
			}
		},
		stop: () => {
			if (disposed) {
				return
			}

			if (pendingStart !== null) {
				pendingStart.abort()
				pendingStart = null
				setPhase({ type: "gate", format: snapshot.info?.format ?? null })

				return
			}

			if (run !== null) {
				deps.cancel(run.id)
			}
		},
		submitPassword: password => {
			if (disposed || run !== null || password === "") {
				return
			}

			const summary = summaryOf(snapshot.phase)

			// Entries already shown are kept: the password is only checked against them.
			if (summary !== null && snapshot.phase.type !== "failed" && snapshot.store.entryCount > 0) {
				begin("verify", password)
			} else if (snapshot.info !== null) {
				begin("full", password)
			}
		},
		retry: () => {
			if (disposed || run !== null) {
				return
			}

			if (snapshot.info === null) {
				resolveInfo()
			} else {
				begin("full", accepted)
			}
		},
		password: () => accepted,
		acceptPassword: password => {
			if (disposed || password === "") {
				return
			}

			accepted = password
			holdAccepted()

			const summary = summaryOf(snapshot.phase)

			if (summary !== null && !summary.verifying && (summary.password === "required" || summary.password === "wrong")) {
				setPhase(withSummary(snapshot.phase, { ...summary, password: "right", verifyError: null }))
			}
		},
		costAccepted: () => costAccepted,
		acceptCost: () => {
			if (!disposed) {
				costAccepted = true
			}
		},
		rememberDirPath: path => {
			dirPath = path
		},
		restoredDirPath: () => dirPath,
		dispose: () => {
			if (disposed) {
				return
			}

			const phase = snapshot.phase

			pendingStart?.abort()
			pendingStart = null
			headRead?.abort()
			headRead = null

			if (run !== null) {
				deps.cancel(run.id)
			}

			if (phase.type === "done") {
				cache?.put(source.uuid, {
					store: snapshot.store,
					summary: { ...phase.summary, verifying: false, verifyWaiting: false, verifyError: null },
					password: accepted,
					lastDirPath: dirPath,
					costAccepted,
					entries: snapshot.store.entryCount
				})
			}

			disposed = true
			token += 1
			run = null
			accepted = undefined
			listeners.clear()
			held.release()
		}
	}
}
