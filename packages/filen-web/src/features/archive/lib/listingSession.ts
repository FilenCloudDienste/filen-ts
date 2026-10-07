import * as Comlink from "comlink"
import type { ArchiveFormat, ListUpdate, PasswordCheck } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO, type ErrorDTO } from "@/lib/sdk/errors"
import type { ListReportDTO } from "@/lib/sdk/jobErrors"
import type { ArchiveNameInfo, ListJobEvent, ListJobParams } from "@/workers/sdk.worker"
import { archiveNameInfo, cachedArchiveNameInfo } from "@/features/drive/lib/archiveHelpers"
import { AUTO_LIST_DELAY_MS, gateFor } from "@/features/archive/lib/archiveGate.logic"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import { createEntryStore, type EntryStore } from "@/features/archive/lib/entryStore"
import type { ListingCache } from "@/features/archive/lib/listingCache"

// One archive's listing for the browser: which phase it is in, and the entries read so far. Each run is a
// job of its own id, taking the page's archive slot as any archive job does.

export type ListingPhase =
	| { type: "resolving" }
	| { type: "gate"; format: ArchiveFormat | null }
	| { type: "starting" }
	// Another archive job holds the page's slot.
	| { type: "waiting" }
	| { type: "reading"; bytesRead: number; archiveBytes: number; entries: number; bytesPerSecond: number | null; etaMs: number | null }
	// Nothing could be listed without a password (a 7z whose index is encrypted).
	| { type: "needsPassword"; wrong: boolean }
	| { type: "done"; summary: ListSummary }
	// The user stopped it; the entries read until then stay.
	| { type: "stopped"; summary: ListSummary }
	// The entries read before the failure stay (a damaged tar); no summary when the call itself was refused.
	| { type: "failed"; error: ErrorDTO; summary: ListSummary | null }

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
	listArchive: (
		id: string,
		params: ListJobParams,
		password: string | undefined,
		onEvent: (event: ListJobEvent) => void
	) => Promise<ListReportDTO>
	cancel: (id: string) => void
	release: (id: string) => void
	newId: () => string
	// Resolves when the time is up or the signal aborts, whichever comes first.
	delay: (ms: number, signal: AbortSignal) => Promise<void>
	nameInfo: (name: string) => ArchiveNameInfo | Promise<ArchiveNameInfo>
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
	listArchive: (id, params, password, onEvent) => sdkApi.listArchive(id, params, password, Comlink.proxy(onEvent)),
	cancel: id => {
		void sdkApi.cancelTransfer(id)
	},
	release: id => {
		void sdkApi.releaseJob(id)
	},
	newId: () => crypto.randomUUID(),
	delay: abortableDelay,
	nameInfo: name => cachedArchiveNameInfo(name) ?? archiveNameInfo(name)
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

function readingPhase(update: ListUpdate): ListingPhase {
	return {
		type: "reading",
		bytesRead: Number(update.bytesRead),
		archiveBytes: Number(update.archiveBytes),
		entries: Number(update.entries),
		bytesPerSecond: update.bytesPerSecond === undefined ? null : Number(update.bytesPerSecond),
		etaMs: update.etaMs === undefined ? null : Number(update.etaMs)
	}
}

function summaryOfPhase(phase: ListingPhase): ListSummary | null {
	switch (phase.type) {
		case "done":
		case "stopped":
		case "failed":
			return phase.summary
		default:
			return null
	}
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

function isPasswordError(error: ErrorDTO): boolean {
	return error.kind === "ArchivePasswordRequired" || error.kind === "ArchiveWrongPassword"
}

// A full run lists into a fresh store; a verify run checks a password against what is shown, its entries
// left undelivered.
interface Run {
	id: string
	token: number
	kind: "full" | "verify"
	store: EntryStore
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
	let disposed = false

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
		const summary = summaryOfPhase(snapshot.phase)

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
			// Stopped before anything was read (while waiting for the slot, say): as if never started.
			setPhase(
				current.store.entryCount === 0
					? { type: "gate", format: report.format ?? snapshot.info?.format ?? null }
					: { type: "stopped", summary },
				current.store
			)
		} else if (isPasswordError(error)) {
			setPhase({ type: "needsPassword", wrong: error.kind === "ArchiveWrongPassword" || password !== undefined }, current.store)
		} else {
			setPhase({ type: "failed", error, summary }, current.store)
		}
	}

	const settleVerify = (report: ListReportDTO | null, error: ErrorDTO | null, password: string): void => {
		const summary = summaryOfPhase(snapshot.phase)

		if (summary === null) {
			return
		}

		const failure = error ?? report?.error ?? null
		const check = failure === null ? (report?.password ?? "wrong") : "wrong"
		let next: ListSummary

		if (failure !== null && !isPasswordError(failure)) {
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
		const onEvent = (event: ListJobEvent): void => {
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

			if (event.type === "entries") {
				// Appended unannounced: the next update tells, at most every 200 ms.
				current.store.append(event.batch)

				return
			}

			switch (event.update.phase) {
				case "waitingForWorker":
					setPhase({ type: "waiting" })

					break
				case "reading":
					setPhase(readingPhase(event.update))

					break
				default:
					break
			}
		}

		try {
			const report = await deps.listArchive(
				current.id,
				{
					archive: source.file,
					skipMacMetadata: true,
					keepReportEntries: false,
					deliverEntries: current.kind === "full"
				},
				password,
				onEvent
			)

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

			if (current.kind === "verify" && password !== undefined) {
				settleVerify(null, asErrorDTO(e), password)
			} else {
				setPhase({ type: "failed", error: asErrorDTO(e), summary: null })
			}
		} finally {
			// Only once the call settled: a released id would orphan a run still winding down.
			deps.release(current.id)
		}
	}

	const begin = (kind: Run["kind"], password: string | undefined): void => {
		pendingStart?.abort()
		pendingStart = null

		token += 1

		const current: Run = { id: deps.newId(), token, kind, store: kind === "full" ? createEntryStore() : snapshot.store }

		run = current

		if (kind === "full") {
			// A fresh store: the browser starts over at its root.
			dirPath = ""
			setPhase({ type: "starting" }, current.store)
		} else {
			const summary = summaryOfPhase(snapshot.phase)

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

		if (gateFor(info.format, source.size) === "gate") {
			setPhase({ type: "gate", format: info.format })
		} else {
			scheduleStart()
		}
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

		if (snapshot.phase.type !== "resolving" && summaryOfPhase(snapshot.phase) === null) {
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

			const summary = summaryOfPhase(snapshot.phase)

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

			const summary = summaryOfPhase(snapshot.phase)

			if (summary !== null && !summary.verifying && (summary.password === "required" || summary.password === "wrong")) {
				setPhase(withSummary(snapshot.phase, { ...summary, password: "right", verifyError: null }))
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

			if (run !== null) {
				deps.cancel(run.id)
			}

			if (phase.type === "done") {
				cache?.put(source.uuid, {
					store: snapshot.store,
					summary: { ...phase.summary, verifying: false, verifyWaiting: false, verifyError: null },
					password: accepted,
					lastDirPath: dirPath,
					entries: snapshot.store.entryCount
				})
			}

			disposed = true
			token += 1
			run = null
			accepted = undefined
			listeners.clear()
		}
	}
}
