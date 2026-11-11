import { randomUUID } from "node:crypto"
import path from "node:path"
import type { OpenDialogOptions, SaveDialogOptions } from "electron"
import type {
	DesktopDownloadDirectoryChoice,
	DesktopPrefs,
	DesktopSdkRef,
	DesktopSyncHostState,
	DesktopTransfer,
	DesktopTransferError,
	DesktopTransferEvent,
	DesktopTransferKind,
	DesktopTransferOrigin,
	DesktopTransferOutcome,
	DesktopTransferProgress,
	DesktopTransferResult,
	DesktopTransferStart,
	DesktopUploadParent,
	DesktopUploadStart
} from "@filen/shared/desktop"
import { localCollisionKey, localName, type LocalPlatform } from "@filen/shared/localName"
import { CHANNELS } from "../../shared/channels.ts"
import {
	type FromNative,
	LISTING_TTL_MS,
	type NativeTransferSpec,
	type NativeTreeEntry,
	sdkValuesFit,
	specSdkLength,
	TRANSFER_SDK_MAX_LENGTH
} from "../../shared/nativeProtocol.ts"
import type { NativeSupervisor } from "../native/supervisor.ts"
import { LIST_TREE_TIMEOUT_MS, type NativeTransfersResult } from "../native/rpc.ts"
import type { Page } from "../pages.ts"
import type { StagingEntry, StagingJournal } from "./journal.ts"
import { freeTarget } from "./paths.ts"

// Drive transfers on real paths, run by the native host: where downloads go (dialogs, the download directory pref,
// keep-both names), the rows the page shows, the host's events fanned out per round, and every way a transfer ends
// without the host (a stopped host, a sign-out, a failed start). SDK values pass through untouched; main reads only a
// file's uuid, for the SDK temp's name.

export type DownloadDestination =
	// The download directory pref, else a dialog; `ask`: always the directory picker.
	| { kind: "prefs"; ask?: boolean }
	// Keep-both names inside `path`.
	| { kind: "directory"; path: string }
	// One item to exactly `path`: replace for the save dialog, macOS promise URLs and temp trees.
	| { kind: "exact"; path: string; conflict: "replace" | "keepBoth" }

// A destination with its dialog answered.
type ResolvedDestination = Exclude<DownloadDestination, { kind: "prefs" }>

export interface NativeDownloadItem {
	kind: DesktopTransferKind
	ref: DesktopSdkRef
	name: string
	size: number
}

export interface DownloadSettle {
	id: string
	outcome: DesktopTransferOutcome
	error?: DesktopTransferError
	path: string | null
}

// onTemp: once the host acked a file download, the file the SDK grows: join(dirname(target), fileUuid + ".filendl").
export interface DownloadWatch {
	onProgress?(id: string, bytes: number, size: number): void
	onTemp?(id: string, path: string): void
	onSettled(settle: DownloadSettle): void
}

export interface TransfersService {
	startDownload(request: {
		items: readonly NativeDownloadItem[]
		destination: DownloadDestination
		origin: DesktopTransferOrigin
		watch?: DownloadWatch
		revealable?: boolean
	}): Promise<DesktopTransferResult<DesktopTransferStart>>
	listTree(request: {
		listingId: string
		items: readonly NativeDownloadItem[]
		maxEntries: number
	}): Promise<DesktopTransferResult<{ entries: NativeTreeEntry[] } | { tooMany: number }>>
	// Files of a held listing into exact temp paths (drag-out only): rows with origin "drag", never revealable.
	startListedDownload(request: {
		listingId: string
		entries: readonly { index: number; path: string; name: string; size: number }[]
		watch: DownloadWatch
	}): Promise<DesktopTransferResult<DesktopTransferStart>>
	releaseTree(listingId: string): void
	startUpload(request: {
		paths: readonly string[]
		parent: DesktopUploadParent
		origin: DesktopTransferOrigin
	}): Promise<DesktopTransferResult<DesktopUploadStart>>
	pickUpload(kind: DesktopTransferKind, parent: DesktopUploadParent): Promise<DesktopTransferResult<DesktopTransferStart>>
	cancel(ids: readonly string[]): void
	setPaused(ids: readonly string[], paused: boolean): void
	list(): DesktopTransfer[]
	subscribe(page: Page, on: boolean): void
	pageGone(pageId: number): void
	reveal(id: string): Promise<DesktopTransferResult<null>>
	open(id: string): Promise<DesktopTransferResult<null>>
	chooseDownloadDirectory(): Promise<DesktopDownloadDirectoryChoice>
	nativeEvent(message: Extract<FromNative, { t: "transfers" }>, userId: string): void
	hostChanged(state: DesktopSyncHostState, generation: number): void
	// No host call: the host's own shutdown aborts what it runs.
	signedOut(): void
	// Running transfers plus held listings (of `userId` when given): the host stays up while this is above 0.
	active(userId?: string): number
}

export interface TransfersServiceDeps {
	supervisor: Pick<NativeSupervisor, "callTransfers" | "callTransfersIfRunning" | "user" | "ensure" | "generation">
	prefs: { get(): DesktopPrefs; setDownloadDirectory(path: string | null): Promise<DesktopPrefs> }
	dialogs: { save(options: SaveDialogOptions): Promise<string | null>; open(options: OpenDialogOptions): Promise<string[] | null> }
	fs: {
		stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number } | null>
		// lstat-like: a dangling link counts as there.
		exists(path: string): Promise<boolean>
	}
	shell: { showItemInFolder(path: string): void; openPath(path: string): Promise<string> }
	journal: StagingJournal
	downloadsDir(): string
	platform: NodeJS.Platform
	now(): number
	log: { info(message: string): void; warn(message: string): void }
}

// Finished downloads reveal and open can still reach, oldest dropped first.
const FINISHED_KEPT = 200

// The protocol's text limit.
const MESSAGE_MAX = 4096

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface Row {
	transfer: DesktopTransfer
	userId: string
	// Download target (the host's savedPath once settled); null for uploads.
	path: string | null
	// The host generation that acked the start; null until then.
	generation: number | null
	watch: DownloadWatch | undefined
	// The SDK temp a file download grows, reported to watch.onTemp on the ack.
	temp: string | null
	reservation: string | null
	// A cancel asked for before the ack; sent with it.
	cancelled: boolean
}

interface Listing {
	userId: string
	usedAt: number
	generation: number
}

interface PlannedRow {
	spec: NativeTransferSpec
	row: Row
	staging: StagingEntry | null
}

const UNAUTHENTICATED = { ok: false, error: { code: "unauthenticated" } } as const

const INVALID = { ok: false, error: { code: "invalidItem" } } as const

const CANCELED = { ok: true, value: { status: "canceled" } } as const

function localPlatformOf(platform: NodeJS.Platform): LocalPlatform {
	return platform === "win32" || platform === "darwin" ? platform : "linux"
}

// The uuid of a file ref, for the SDK temp's name; null when the value does not name one.
function fileUuidOf(ref: DesktopSdkRef): string | null {
	try {
		const value: unknown = JSON.parse(ref.value)
		const uuid = typeof value === "object" && value !== null && "uuid" in value ? value.uuid : undefined

		return typeof uuid === "string" && UUID.test(uuid) ? uuid : null
	} catch {
		return null
	}
}

// Specs in host calls of at most the protocol's SDK size each (usually one; an upload repeats its parent per spec).
function batches(specs: readonly NativeTransferSpec[]): NativeTransferSpec[][] {
	if (sdkValuesFit(specs, specSdkLength)) {
		return [[...specs]]
	}

	const result: NativeTransferSpec[][] = []
	let batch: NativeTransferSpec[] = []
	let length = 0

	for (const spec of specs) {
		const size = specSdkLength(spec)

		if (batch.length > 0 && length + size > TRANSFER_SDK_MAX_LENGTH) {
			result.push(batch)
			batch = []
			length = 0
		}

		batch.push(spec)
		length += size
	}

	result.push(batch)

	return result
}

export function createTransfersService(deps: TransfersServiceDeps): TransfersService {
	const { supervisor, dialogs, fs, journal, log } = deps
	const local = localPlatformOf(deps.platform)
	const rows = new Map<string, Row>()
	// Finished, revealable downloads: id → path, insertion order = age.
	const finished = new Map<string, string>()
	const listings = new Map<string, Listing>()
	// dirname + "\0" + collision key of the names in-flight downloads were given.
	const reserved = new Set<string>()
	const pages = new Map<number, Page>()
	let hostRunning = false
	let lastDir: string | null = null
	let listingTimer: NodeJS.Timeout | undefined

	function push(events: readonly DesktopTransferEvent[]): void {
		if (events.length === 0) {
			return
		}

		for (const page of pages.values()) {
			page.send(CHANNELS.transfersEvents, events)
		}
	}

	function reservationOf(target: string): string {
		return `${path.dirname(target)}\0${localCollisionKey(path.basename(target))}`
	}

	// Claims the candidate's name when nothing in flight holds it and nothing is on disk there.
	async function taken(candidate: string): Promise<boolean> {
		const key = reservationOf(candidate)

		if (reserved.has(key)) {
			return true
		}

		reserved.add(key)

		if (await fs.exists(candidate)) {
			reserved.delete(key)

			return true
		}

		return false
	}

	function forget(row: Row): void {
		rows.delete(row.transfer.id)

		if (row.reservation !== null) {
			reserved.delete(row.reservation)
		}
	}

	// Ends a row and returns its settled event; `savedPath` from the host replaces the planned path.
	function settle(row: Row, outcome: DesktopTransferOutcome, error?: DesktopTransferError, uploaded?: string, savedPath?: string) {
		const id = row.transfer.id
		const target = savedPath ?? row.path

		forget(row)

		if (row.transfer.revealable && target !== null && (outcome === "done" || outcome === "completedWithErrors")) {
			finished.set(id, target)

			if (finished.size > FINISHED_KEPT) {
				for (const oldest of finished.keys()) {
					finished.delete(oldest)

					break
				}
			}
		}

		row.watch?.onSettled({ id, outcome, ...(error === undefined ? {} : { error }), path: target })

		return {
			t: "settled",
			id,
			outcome,
			...(error === undefined ? {} : { error }),
			...(uploaded === undefined ? {} : { uploaded })
		} satisfies DesktopTransferEvent
	}

	// Rows that end without the host: their staging files are removed here.
	function settleLocally(ended: readonly Row[], outcome: DesktopTransferOutcome, error?: DesktopTransferError): void {
		if (ended.length === 0) {
			return
		}

		const ids = ended.map(row => row.transfer.id)

		push(ended.map(row => settle(row, outcome, error)))
		journal.discard(ids).catch((caught: unknown) => {
			log.warn(`transfers: staging not discarded: ${caught instanceof Error ? caught.message : String(caught)}`)
		})
	}

	function activeOf(userId?: string): number {
		let count = 0

		for (const row of rows.values()) {
			if (userId === undefined || row.userId === userId) {
				count++
			}
		}

		for (const listing of listings.values()) {
			if (userId === undefined || listing.userId === userId) {
				count++
			}
		}

		return count
	}

	function idle(reason: string, userId: string): void {
		if (activeOf(userId) === 0) {
			supervisor.ensure(reason)
		}
	}

	// One timer while main holds listings: the first to pass the host's TTL.
	function armListings(): void {
		clearTimeout(listingTimer)
		listingTimer = undefined

		let at = Infinity

		for (const listing of listings.values()) {
			at = Math.min(at, listing.usedAt + LISTING_TTL_MS)
		}

		if (at === Infinity) {
			return
		}

		listingTimer = setTimeout(
			() => {
				listingTimer = undefined

				const now = deps.now()
				let expired = false

				for (const [id, listing] of listings) {
					if (listing.usedAt + LISTING_TTL_MS <= now) {
						listings.delete(id)
						expired = true
					}
				}

				armListings()

				if (expired) {
					supervisor.ensure("listing expired")
				}
			},
			Math.max(0, at - deps.now())
		)
	}

	function sendIfRunning(op: "transfersCancel" | "transfersPause", byUser: Map<string, string[]>, paused?: boolean): void {
		for (const [userId, ids] of byUser) {
			const sent =
				op === "transfersCancel"
					? supervisor.callTransfersIfRunning(op, { ids }, userId)
					: supervisor.callTransfersIfRunning(op, { ids, paused: paused === true }, userId)

			void sent.then(result => {
				if (!result.ok && result.error.code !== "hostUnavailable") {
					log.warn(`transfers: ${op} failed: ${result.error.code}`)
				}
			})
		}
	}

	function sendRelease(listingId: string, userId: string): void {
		void supervisor.callTransfersIfRunning("transfersReleaseTree", { listingId }, userId)
	}

	function snapshot(): DesktopTransfer[] {
		return [...rows.values()].map(row => ({ ...row.transfer, files: row.transfer.files === null ? null : { ...row.transfer.files } }))
	}

	function byUser(list: readonly Row[]): Map<string, string[]> {
		const grouped = new Map<string, string[]>()

		for (const row of list) {
			const ids = grouped.get(row.userId) ?? []

			ids.push(row.transfer.id)
			grouped.set(row.userId, ids)
		}

		return grouped
	}

	function newRow(
		userId: string,
		fields: Pick<DesktopTransfer, "direction" | "kind" | "origin" | "group" | "name" | "parentUuid" | "size" | "revealable">,
		extra: { path: string | null; watch?: DownloadWatch | undefined; temp?: string | null; reservation?: string | null }
	): Row {
		return {
			transfer: { id: randomUUID(), ...fields, bytes: 0, files: null, paused: false, startedAt: deps.now() },
			userId,
			path: extra.path,
			generation: null,
			watch: extra.watch,
			temp: extra.temp ?? null,
			reservation: extra.reservation ?? null,
			cancelled: false
		}
	}

	// Records the rows, journals their staging, shows them, then hands them to the host in one call (more only past the
	// protocol's size). A failed call ends its rows here.
	async function begin(userId: string, planned: readonly PlannedRow[]): Promise<DesktopTransferResult<string[]>> {
		for (const { row } of planned) {
			rows.set(row.transfer.id, row)
		}

		journal.add(planned.flatMap(item => (item.staging === null ? [] : [item.staging])))
		push([{ t: "added", transfers: planned.map(item => ({ ...item.row.transfer })) }])

		let failure: DesktopTransferError | null = null

		for (const batch of batches(planned.map(item => item.spec))) {
			const ids = batch.map(spec => spec.id)

			if (failure !== null) {
				settleLocally(
					ids.flatMap(id => rows.get(id) ?? []),
					"error",
					failure
				)

				continue
			}

			const result: NativeTransfersResult<"transfersStart"> = await supervisor.callTransfers(
				"transfersStart",
				{ specs: batch },
				userId
			)
			// Rows a sign-out ended meanwhile are gone.
			const own = ids.flatMap(id => rows.get(id) ?? [])

			if (!result.ok) {
				failure = result.error

				if (failure.code === "timeout") {
					// The host may run them still.
					sendIfRunning("transfersCancel", new Map([[userId, ids]]))
				}

				settleLocally(own, "error", failure)

				continue
			}

			const generation = supervisor.generation()
			const cancelled: Row[] = []
			const paused: Row[] = []

			for (const row of own) {
				row.generation = generation

				if (row.cancelled) {
					cancelled.push(row)
				} else if (row.transfer.paused) {
					paused.push(row)
				}

				if (row.temp !== null) {
					row.watch?.onTemp?.(row.transfer.id, row.temp)
				}
			}

			sendIfRunning("transfersPause", byUser(paused), true)
			sendIfRunning("transfersCancel", byUser(cancelled))
		}

		if (failure !== null) {
			log.warn(`transfers: start failed: ${failure.code}`)
			idle("transfers settled", userId)

			return { ok: false, error: failure }
		}

		return { ok: true, value: planned.map(item => item.row.transfer.id) }
	}

	async function existingDirectory(target: string): Promise<boolean> {
		return (await fs.stat(target))?.isDirectory() === true
	}

	async function pickDirectory(): Promise<string | null> {
		const picked = await dialogs.open({ properties: ["openDirectory", "createDirectory"], defaultPath: lastDir ?? deps.downloadsDir() })
		const dir = picked?.[0]

		if (dir === undefined) {
			return null
		}

		lastDir = dir

		return dir
	}

	// Where a `prefs` download goes: the pref's directory, else a save dialog for one file, else a directory picker.
	async function resolvePrefs(items: readonly NativeDownloadItem[], ask: boolean): Promise<ResolvedDestination | null> {
		const fixed = deps.prefs.get().downloadDirectory

		if (!ask && fixed !== null) {
			if (await existingDirectory(fixed)) {
				return { kind: "directory", path: fixed }
			}

			log.warn(`transfers: download directory ${fixed} is gone; asking`)
		}

		const [only] = items

		if (!ask && items.length === 1 && only?.kind === "file") {
			const saved = await dialogs.save({ defaultPath: path.join(lastDir ?? deps.downloadsDir(), localName(only.name, local)) })

			if (saved === null) {
				return null
			}

			lastDir = path.dirname(saved)

			return { kind: "exact", path: saved, conflict: "replace" }
		}

		const dir = await pickDirectory()

		return dir === null ? null : { kind: "directory", path: dir }
	}

	async function planDownload(
		item: NativeDownloadItem,
		destination: ResolvedDestination,
		common: { userId: string; group: string; origin: DesktopTransferOrigin; revealable: boolean; watch: DownloadWatch | undefined }
	): Promise<PlannedRow> {
		let target: string
		let reservation: string | null = null

		if (destination.kind === "exact") {
			target = destination.path
		} else {
			target = await freeTarget(destination.path, localName(item.name, local), item.kind, taken)
			reservation = reservationOf(target)
		}

		const uuid = item.kind === "file" ? fileUuidOf(item.ref) : null
		const row = newRow(
			common.userId,
			{
				direction: "download",
				kind: item.kind,
				origin: common.origin,
				group: common.group,
				name: item.name,
				parentUuid: null,
				size: item.size,
				revealable: common.revealable
			},
			{
				path: target,
				watch: common.watch,
				temp: uuid === null ? null : path.join(path.dirname(target), `${uuid}.filendl`),
				reservation
			}
		)
		const id = row.transfer.id

		if (item.kind === "directory") {
			return {
				spec: { id, t: "downloadDirectory", dir: item.ref, path: target },
				row,
				staging: { id, dir: target, names: [], tree: true }
			}
		}

		return {
			spec: {
				id,
				t: "downloadFile",
				file: item.ref,
				path: target,
				conflict: destination.kind === "exact" ? destination.conflict : "keepBoth"
			},
			row,
			staging: { id, dir: path.dirname(target), names: [`${id}.filendl`, ...(uuid === null ? [] : [`${uuid}.filendl`])], tree: false }
		}
	}

	async function startUpload(request: {
		paths: readonly string[]
		parent: DesktopUploadParent
		origin: DesktopTransferOrigin
	}): Promise<DesktopTransferResult<DesktopUploadStart>> {
		const user = await supervisor.user()

		if (user === null) {
			return UNAUTHENTICATED
		}

		const group = randomUUID()
		const stats = await Promise.all(request.paths.map(target => fs.stat(target)))
		const planned: PlannedRow[] = []
		const skipped: number[] = []

		stats.forEach((stat, index) => {
			const local = request.paths[index] ?? ""
			const name = path.basename(local)
			const directory = stat?.isDirectory() === true

			if (stat === null || (!directory && !stat.isFile()) || name.length === 0 || name.length > 255) {
				log.warn(`transfers: ${local} not uploaded: ${stat === null ? "missing" : "not a file or directory"}`)
				skipped.push(index)

				return
			}

			const row = newRow(
				user.userId,
				{
					direction: "upload",
					kind: directory ? "directory" : "file",
					origin: request.origin,
					group,
					name,
					parentUuid: request.parent.uuid,
					size: directory ? 0 : stat.size,
					revealable: false
				},
				{ path: null }
			)
			const id = row.transfer.id

			planned.push({
				spec: directory
					? { id, t: "uploadDirectory", path: local, parent: request.parent.ref, name }
					: { id, t: "uploadFile", path: local, parent: request.parent.ref },
				row,
				staging: null
			})
		})

		if (planned.length === 0) {
			return { ok: true, value: { status: "started", ids: [], skipped } }
		}

		const result = await begin(user.userId, planned)

		return result.ok ? { ok: true, value: { status: "started", ids: result.value, skipped } } : result
	}

	async function finishedPath(id: string): Promise<string | null> {
		const target = finished.get(id)

		return target !== undefined && (await fs.exists(target)) ? target : null
	}

	return {
		startDownload: async request => {
			const user = await supervisor.user()

			if (user === null) {
				return UNAUTHENTICATED
			}

			const destination =
				request.destination.kind === "prefs"
					? await resolvePrefs(request.items, request.destination.ask === true)
					: request.destination

			if (destination === null) {
				return CANCELED
			}

			if (destination.kind === "exact" && request.items.length !== 1) {
				return INVALID
			}

			const common = {
				userId: user.userId,
				group: randomUUID(),
				origin: request.origin,
				revealable: request.revealable ?? request.origin === "page",
				watch: request.watch
			}
			const planned: PlannedRow[] = []

			for (const item of request.items) {
				planned.push(await planDownload(item, destination, common))
			}

			const result = await begin(user.userId, planned)

			return result.ok ? { ok: true, value: { status: "started", ids: result.value } } : result
		},
		listTree: async request => {
			const user = await supervisor.user()

			if (user === null) {
				return UNAUTHENTICATED
			}

			const args = {
				listingId: request.listingId,
				items: request.items.map(item => ({ ref: item.ref, name: item.name })),
				maxEntries: request.maxEntries
			}
			const result = await supervisor.callTransfers("transfersListTree", args, user.userId, LIST_TREE_TIMEOUT_MS)

			if (!result.ok) {
				if (result.error.code === "timeout" || result.error.code === "hostUnavailable") {
					// A host that finished the listing after all must not hold it.
					sendRelease(request.listingId, user.userId)
				}

				return result
			}

			if ("entries" in result.value && result.value.entries.some(entry => entry.listIndex !== null)) {
				listings.set(request.listingId, { userId: user.userId, usedAt: deps.now(), generation: supervisor.generation() })
				armListings()
			}

			return result
		},
		startListedDownload: async request => {
			const listing = listings.get(request.listingId)

			if (listing === undefined) {
				return INVALID
			}

			listing.usedAt = deps.now()
			armListings()

			const group = randomUUID()
			const planned = request.entries.map((entry): PlannedRow => {
				const row = newRow(
					listing.userId,
					{
						direction: "download",
						kind: "file",
						origin: "drag",
						group,
						name: entry.name,
						parentUuid: null,
						size: entry.size,
						revealable: false
					},
					{ path: entry.path, watch: request.watch }
				)
				const id = row.transfer.id

				return {
					spec: { id, t: "downloadListed", listingId: request.listingId, index: entry.index, path: entry.path },
					row,
					staging: { id, dir: path.dirname(entry.path), names: [`${id}.filendl`], tree: false }
				}
			})

			if (planned.length === 0) {
				return { ok: true, value: { status: "started", ids: [] } }
			}

			const result = await begin(listing.userId, planned)

			return result.ok ? { ok: true, value: { status: "started", ids: result.value } } : result
		},
		releaseTree: listingId => {
			const listing = listings.get(listingId)

			if (listing === undefined) {
				return
			}

			listings.delete(listingId)
			armListings()
			sendRelease(listingId, listing.userId)
			idle("listing released", listing.userId)
		},
		startUpload,
		pickUpload: async (kind, parent) => {
			if ((await supervisor.user()) === null) {
				return UNAUTHENTICATED
			}

			const paths = await dialogs.open({ properties: [kind === "file" ? "openFile" : "openDirectory", "multiSelections"] })

			if (paths === null || paths.length === 0) {
				return CANCELED
			}

			const result = await startUpload({ paths, parent, origin: "page" })

			return result.ok && result.value.status === "started"
				? { ok: true, value: { status: "started", ids: result.value.ids } }
				: result
		},
		cancel: ids => {
			const known = ids.flatMap(id => {
				const row = rows.get(id)

				if (row === undefined || row.cancelled) {
					return []
				}

				row.cancelled = true

				return [row]
			})

			// Not yet acked: sent with the ack.
			sendIfRunning("transfersCancel", byUser(known.filter(row => row.generation !== null)))
		},
		setPaused: (ids, paused) => {
			const changed = ids.flatMap(id => {
				const row = rows.get(id)

				if (row === undefined || row.transfer.paused === paused) {
					return []
				}

				row.transfer.paused = paused

				return [row]
			})

			if (changed.length === 0) {
				return
			}

			sendIfRunning("transfersPause", byUser(changed.filter(row => row.generation !== null)), paused)
			push([{ t: "paused", ids: changed.map(row => row.transfer.id), paused }])
		},
		list: snapshot,
		subscribe: (page, on) => {
			if (!on) {
				pages.delete(page.id)

				return
			}

			pages.set(page.id, page)
			page.send(CHANNELS.transfersEvents, [{ t: "snapshot", transfers: snapshot() }] satisfies DesktopTransferEvent[])
		},
		pageGone: pageId => {
			pages.delete(pageId)
		},
		reveal: async id => {
			const target = await finishedPath(id)

			if (target === null) {
				return { ok: false, error: { code: "localMissing" } }
			}

			deps.shell.showItemInFolder(target)

			return { ok: true, value: null }
		},
		open: async id => {
			const target = await finishedPath(id)

			if (target === null) {
				return { ok: false, error: { code: "localMissing" } }
			}

			const refusal = await deps.shell.openPath(target)

			return refusal === ""
				? { ok: true, value: null }
				: { ok: false, error: { code: "unknown", message: refusal.slice(0, MESSAGE_MAX) } }
		},
		chooseDownloadDirectory: async () => {
			const picked = await dialogs.open({
				properties: ["openDirectory", "createDirectory"],
				defaultPath: deps.prefs.get().downloadDirectory ?? deps.downloadsDir()
			})
			const dir = picked?.[0]

			if (dir === undefined) {
				return { status: "canceled" }
			}

			await deps.prefs.setDownloadDirectory(dir)

			return { status: "chosen", path: dir }
		},
		nativeEvent: (message, userId) => {
			const updates: DesktopTransferProgress[] = []
			const settled: DesktopTransferEvent[] = []

			for (const event of message.events) {
				const row = rows.get(event.id)

				if (row === undefined || row.userId !== userId) {
					continue
				}

				if (event.k === "progress") {
					row.transfer.size = event.size
					row.transfer.bytes = event.bytes
					row.transfer.files = event.files
					updates.push({ id: event.id, size: event.size, bytes: event.bytes, files: event.files })
					row.watch?.onProgress?.(event.id, event.bytes, event.size)
				} else {
					settled.push(settle(row, event.outcome, event.error, event.uploaded, event.savedPath))
				}
			}

			push(updates.length === 0 ? settled : [{ t: "progress", updates }, ...settled])

			if (settled.length > 0) {
				journal.remove(settled.flatMap(event => (event.t === "settled" ? [event.id] : [])))
				idle("transfers settled", userId)
			}
		},
		hostChanged: (state, generation) => {
			const was = hostRunning

			hostRunning = state.state === "running"

			if (!was || hostRunning) {
				return
			}

			for (const [id, listing] of listings) {
				if (listing.generation === generation) {
					listings.delete(id)
				}
			}

			armListings()
			settleLocally(
				[...rows.values()].filter(row => row.generation === generation),
				"error",
				{ code: "interrupted" }
			)
		},
		signedOut: () => {
			const all = [...rows.values()]

			listings.clear()
			armListings()
			finished.clear()
			lastDir = null
			settleLocally(all, "cancelled")
		},
		active: activeOf
	}
}
