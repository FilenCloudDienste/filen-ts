import path from "node:path"
import type { DesktopSdkRef, DesktopTransferError, DesktopTransferFiles, DesktopTransferOutcome } from "@filen/shared/desktop"
import { SdkShapeError, ubrnOf, wasmOf } from "@filen/shared/sdkShapes"
import { parseEnvelope, stringifyEnvelope } from "@filen/shared/session"
import {
	type FromNative,
	type NativeOpArgs,
	type NativeOpResult,
	type NativeTransferEvent,
	type NativeTransferSpec,
	type NativeTreeEntry,
	SDK_VALUE_MAX_LENGTH,
	TRANSFER_EVENTS_MAX,
	type TransfersOp
} from "../shared/nativeProtocol.ts"
import { type CommitFs, commitDownload, makeFreeDirectory, stagingPathOf } from "./commitDownload.ts"
import type { Quarantine } from "./quarantine.ts"
import { FEED_INTERVAL_MS } from "./reducer.ts"
import { classifyTransfer, isCancelled, TransferCommitError, type TransferErrorSdk } from "./transferErrors.ts"

// Drive uploads and downloads on real paths, run on the napi client. Every call carries a ManagedFuture (abort and
// pause); the SDK caps concurrency client-wide (open files, request limiter), so each transfer is one call and there
// is no queue here. Progress is coalesced into one host message per round; nothing is timed while idle.

// The napi calls the registry uses, with ubrn's signatures. The one place their names live: the installed typings
// lack them until the SDK release that adds them.
export interface TransferClient {
	root(): { uuid: string }
	createDir(parent: unknown, name: string): Promise<unknown>
	uploadFile(
		params: unknown,
		filePath: string,
		callback: { onUpdate(uploadedBytes: bigint): void } | undefined,
		managedFuture: ManagedFuture
	): Promise<unknown>
	downloadFileToPath(
		file: unknown,
		filePath: string,
		callback: { onUpdate(downloadedBytes: bigint): void } | undefined,
		managedFuture: ManagedFuture
	): Promise<void>
	uploadDirRecursively(dirPath: string, callback: DirUploadCallback, target: unknown, managedFuture: ManagedFuture): Promise<void>
	downloadDirRecursively(dirPath: string, callback: DirDownloadCallback, target: unknown, managedFuture: ManagedFuture): Promise<void>
	listDirRecursiveWithPaths(
		dir: unknown,
		progress: undefined,
		errors: { onErrors(errors: unknown[]): void }
	): Promise<{ dirs: { path: string; dir: unknown }[]; files: { path: string; file: unknown }[] }>
}

// Both keys required: napi reads them as given.
export interface ManagedFuture {
	abortSignal: unknown
	pauseSignal: unknown
}

export interface PauseSignalLike {
	pause(): void
	resume(): void
}

export interface ManagedAbortControllerLike {
	abort(): void
	signal(): unknown
}

// Byte counts are deltas since the previous call.
export interface DirUploadCallback {
	onScanProgress(knownDirs: bigint, knownFiles: bigint, knownBytes: bigint): void
	onScanErrors(errors: unknown[]): void
	onScanComplete(totalDirs: bigint, totalFiles: bigint, totalBytes: bigint): void
	onUploadUpdate(uploadedDirs: unknown[], uploadedFiles: unknown[], uploadedBytes: bigint): void
	onUploadErrors(errors: { path: string; error: unknown }[]): void
}

export interface DirDownloadCallback {
	onQueryDownloadProgress(knownBytes: bigint, totalBytes: bigint | undefined): void
	onScanProgress(knownDirs: bigint, knownFiles: bigint, knownBytes: bigint): void
	onScanErrors(errors: unknown[]): void
	onScanComplete(totalDirs: bigint, totalFiles: bigint, totalBytes: bigint): void
	onDownloadUpdate(downloadedDirs: { path: string }[], downloadedFiles: { path: string }[], downloadedBytes: bigint): void
	onDownloadErrors(errors: { path: string; error: unknown; item: unknown }[]): void
}

export interface TransferSdk extends TransferErrorSdk {
	PauseSignal: new () => PauseSignalLike
	ManagedAbortController: new () => ManagedAbortControllerLike
}

export interface TransferRegistry {
	start(specs: readonly NativeTransferSpec[]): void
	cancel(ids: readonly string[]): void
	setPaused(ids: readonly string[], paused: boolean): void
	listTree(args: {
		listingId: string
		items: readonly { ref: DesktopSdkRef; name: string }[]
		maxEntries: number
	}): Promise<{ entries: NativeTreeEntry[] } | { tooMany: number }>
	releaseTree(listingId: string): void
	// Aborts everything and posts nothing from then on: main's view of the host is the only source of "interrupted".
	abortAll(): void
	// Running transfers plus held listings.
	active(): number
}

const TRANSFER_METHODS = [
	"root",
	"createDir",
	"uploadFile",
	"downloadFileToPath",
	"uploadDirRecursively",
	"downloadDirRecursively",
	"listDirRecursiveWithPaths"
] as const satisfies readonly (keyof TransferClient)[]

function hasFunctions(value: object, names: readonly string[]): boolean {
	return names.every(name => typeof (value as Record<string, unknown>)[name] === "function")
}

// The addon and client as the registry's surface, or null when the loaded addon predates the transfer exports.
export function transferBindings(addon: object, client: object): { sdk: TransferSdk; client: TransferClient } | null {
	if (!hasFunctions(addon, ["PauseSignal", "ManagedAbortController"]) || !hasFunctions(client, TRANSFER_METHODS)) {
		return null
	}

	return { sdk: addon as TransferSdk, client: client as TransferClient }
}

// A listing not used for this long is dropped: it holds file keys in memory.
export const LISTING_TTL_MS = 30 * 60_000

// Per transfer, the per-item failures named in the log; the rest are only counted.
const LOGGED_ERRORS = 20

interface Entry {
	readonly id: string
	readonly spec: NativeTransferSpec
	readonly controller: ManagedAbortControllerLike
	readonly pause: PauseSignalLike
	readonly future: ManagedFuture
	size: number
	bytes: number
	// Directory transfers: counts only, never the items.
	files: DesktopTransferFiles | null
	// Directory downloads: the files the scan found, which done + failed must reach.
	scanTotal: number | null
	dirty: boolean
	cancelled: boolean
	logged: number
	marking: Promise<void>
}

interface Listing {
	files: unknown[]
	usedAt: number
}

type Settled = { uploaded?: string | undefined; savedPath?: string | undefined }

type Obj = Record<string, unknown>

function obj(value: unknown): Obj {
	return typeof value === "object" && value !== null ? (value as Obj) : {}
}

// The record inside a `{ tag, inner: [record] }` enum value.
function innerOf(value: unknown): unknown {
	const inner = obj(value)["inner"]

	return Array.isArray(inner) ? inner[0] : undefined
}

function count(value: unknown): number {
	return typeof value === "bigint" && value > 0n ? Number(value) : 0
}

// What the registry reads off a ubrn File (or SharedFile/LinkedFile): never its keys.
function fileFacts(file: unknown): { uuid: string; size: number; mtimeMs: number | null } {
	const record = obj(file)

	if (typeof record["uuid"] !== "string") {
		throw new SdkShapeError("file: expected a uuid")
	}

	const meta = obj(record["meta"])
	const modified = meta["tag"] === "Decoded" ? obj(innerOf(meta))["modified"] : undefined

	return {
		uuid: record["uuid"],
		size: count(record["size"]),
		mtimeMs: typeof modified === "bigint" && modified >= 0n ? Number(modified) : null
	}
}

// A sentinel for a transfer cancelled before its SDK call started.
class Cancelled extends Error {}

export function createTransferRegistry(
	deps: {
		client: TransferClient
		sdk: TransferSdk
		fs: CommitFs
		quarantine: Quarantine
		platform: NodeJS.Platform
		post(message: FromNative): void
		onAuthFailed(): void
		log: { warn(message: string): void }
	},
	intervalMs = FEED_INTERVAL_MS
): TransferRegistry {
	const { client, sdk, fs, quarantine, platform, log } = deps
	const entries = new Map<string, Entry>()
	const dirty = new Set<Entry>()
	let settles: NativeTransferEvent[] = []
	const listings = new Map<string, Listing>()
	// Listings in flight; a release meanwhile removes the id, so the finished listing is not held.
	const pendingListings = new Set<string>()
	// dirname + "\0" + file uuid → the last download into that directory of that file. The SDK's own temp is
	// `<file uuid>.filendl` beside the target and is truncated on open, so these run one after the other.
	const chains = new Map<string, Promise<unknown>>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let timerAt = 0
	let closed = false
	let authReported = false

	// One timer: the next round while something is waiting to be posted, else the first listing to expire.
	function arm(): void {
		if (closed) {
			return
		}

		const now = Date.now()
		let at: number | null = null

		if (dirty.size > 0 || settles.length > 0) {
			at = now + intervalMs
		} else {
			for (const listing of listings.values()) {
				at = Math.min(at ?? Infinity, listing.usedAt + LISTING_TTL_MS)
			}
		}

		if (at === null || (timer !== null && timerAt <= at)) {
			return
		}

		if (timer !== null) {
			clearTimeout(timer)
		}

		timerAt = at
		timer = setTimeout(round, Math.max(0, at - now))
	}

	function round(): void {
		timer = null

		if (closed) {
			return
		}

		const now = Date.now()

		for (const [id, listing] of listings) {
			if (listing.usedAt + LISTING_TTL_MS <= now) {
				listings.delete(id)
			}
		}

		const events: NativeTransferEvent[] = []

		for (const entry of dirty) {
			entry.dirty = false
			events.push({
				k: "progress",
				id: entry.id,
				size: entry.size,
				bytes: entry.bytes,
				files: entry.files === null ? null : { ...entry.files }
			})
		}

		dirty.clear()
		events.push(...settles)
		settles = []

		for (let start = 0; start < events.length; start += TRANSFER_EVENTS_MAX) {
			deps.post({ t: "transfers", events: events.slice(start, start + TRANSFER_EVENTS_MAX) })
		}

		arm()
	}

	function touch(entry: Entry): void {
		if (!entry.dirty && !closed) {
			entry.dirty = true
			dirty.add(entry)
			arm()
		}
	}

	function addBytes(entry: Entry, delta: bigint): void {
		entry.bytes += Number(delta)
		touch(entry)
	}

	function resize(entry: Entry, size: number): void {
		if (entry.size !== size) {
			entry.size = size
			touch(entry)
		}
	}

	function failed(entry: Entry, files: DesktopTransferFiles, items: readonly { path?: string; bytes: number }[]): void {
		for (const item of items) {
			files.failed++
			files.failedBytes += item.bytes

			if (entry.logged < LOGGED_ERRORS && item.path !== undefined) {
				entry.logged++
				log.warn(`transfer ${entry.id}: ${item.path} failed`)
			}
		}

		touch(entry)
	}

	// Marked before the transfer settles, so nothing can be opened unmarked; a failure only logs.
	function mark(entry: Entry, paths: string[]): void {
		entry.marking = entry.marking.then(() =>
			quarantine.mark(paths).catch((error: unknown) => {
				const more = paths.length > 1 ? ` and ${String(paths.length - 1)} more` : ""

				log.warn(`quarantine of ${paths[0] ?? ""}${more} failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		)
	}

	function ensureRunning(entry: Entry): void {
		if (entry.cancelled) {
			throw new Cancelled()
		}
	}

	async function chained<T>(target: string, fileUuid: string, run: () => Promise<T>): Promise<T> {
		const key = `${path.dirname(target)}\0${fileUuid}`
		const current = (chains.get(key) ?? Promise.resolve()).then(run)
		const tail = current.catch(() => undefined)

		chains.set(key, tail)

		try {
			return await current
		} finally {
			if (chains.get(key) === tail) {
				chains.delete(key)
			}
		}
	}

	async function downloadTo(entry: Entry, file: unknown, target: string, conflict: "replace" | "keepBoth"): Promise<string> {
		const staging = stagingPathOf(target, entry.id)

		try {
			ensureRunning(entry)
			await client.downloadFileToPath(file, staging, { onUpdate: delta => addBytes(entry, delta) }, entry.future)

			const final = await commitDownload(fs, staging, target, conflict, platform)

			mark(entry, [final])

			return final
		} catch (error) {
			await fs.unlink(staging).catch((unlinkError: unknown) => {
				if (obj(unlinkError)["code"] !== "ENOENT") {
					log.warn(`staging file ${staging} not removed: ${String(obj(unlinkError)["code"])}`)
				}
			})

			throw error
		}
	}

	function parentOf(ref: DesktopSdkRef): unknown {
		switch (ref.variant) {
			case "AnyNormalDir.Root":
				return { tag: "Root", inner: [client.root()] }
			case "AnyNormalDir.Dir":
				return ubrnOf(ref.variant, parseEnvelope(ref.value))
			default:
				throw new SdkShapeError("parent: expected an AnyNormalDir")
		}
	}

	// The created item as the capped envelope the page holds; left out (with a warning) when it does not convert.
	function envelopeOf(entry: Entry, kind: "File" | "Dir", value: unknown): string | undefined {
		try {
			const envelope = stringifyEnvelope(wasmOf(kind, value))

			if (envelope.length <= SDK_VALUE_MAX_LENGTH) {
				return envelope
			}
		} catch (error) {
			log.warn(
				`transfer ${entry.id}: the uploaded ${kind} did not convert: ${error instanceof Error ? error.message : String(error)}`
			)

			return undefined
		}

		log.warn(`transfer ${entry.id}: the uploaded ${kind} is too large to report`)

		return undefined
	}

	function directoryFiles(entry: Entry): DesktopTransferFiles {
		const files = { total: 0, done: 0, failed: 0, failedBytes: 0 }

		entry.files = files
		touch(entry)

		return files
	}

	function scanned(entry: Entry, files: DesktopTransferFiles, knownFiles: bigint, knownBytes: bigint): void {
		files.total = count(knownFiles)
		entry.size = count(knownBytes)
		touch(entry)
	}

	function scanFailed(entry: Entry, files: DesktopTransferFiles, errors: readonly unknown[]): void {
		failed(
			entry,
			files,
			errors.map(() => ({ bytes: 0 }))
		)
	}

	async function execute(entry: Entry): Promise<Settled> {
		const spec = entry.spec

		switch (spec.t) {
			case "downloadFile": {
				const file = ubrnOf(spec.file.variant, parseEnvelope(spec.file.value))
				const facts = fileFacts(innerOf(file))

				resize(entry, facts.size)

				return { savedPath: await chained(spec.path, facts.uuid, () => downloadTo(entry, file, spec.path, spec.conflict)) }
			}
			case "downloadListed": {
				const listing = listings.get(spec.listingId)
				const file = listing?.files[spec.index]

				if (listing === undefined || file === undefined) {
					throw new TransferCommitError("invalidItem", "no such listed file")
				}

				listing.usedAt = Date.now()

				const facts = fileFacts(file)

				resize(entry, facts.size)

				return {
					savedPath: await chained(spec.path, facts.uuid, () =>
						downloadTo(entry, { tag: "File", inner: [file] }, spec.path, "replace")
					)
				}
			}
			case "downloadDirectory": {
				const target = ubrnOf(spec.dir.variant, parseEnvelope(spec.dir.value))
				const files = directoryFiles(entry)

				ensureRunning(entry)

				const created = await makeFreeDirectory(fs, spec.path)

				await client.downloadDirRecursively(
					created,
					{
						onQueryDownloadProgress: () => undefined,
						onScanProgress: (_dirs, knownFiles, knownBytes) => {
							scanned(entry, files, knownFiles, knownBytes)
						},
						onScanErrors: errors => {
							scanFailed(entry, files, errors)
						},
						onScanComplete: (_dirs, totalFiles, totalBytes) => {
							entry.scanTotal = count(totalFiles)
							scanned(entry, files, totalFiles, totalBytes)
						},
						onDownloadUpdate: (dirs, downloaded, bytes) => {
							files.done += downloaded.length

							const paths: string[] = []

							for (const item of dirs) {
								paths.push(path.join(created, item.path))
							}

							for (const item of downloaded) {
								paths.push(path.join(created, item.path))
							}

							if (paths.length > 0) {
								mark(entry, paths)
							}

							addBytes(entry, bytes)
						},
						onDownloadErrors: errors => {
							failed(
								entry,
								files,
								errors.map(error => ({ path: error.path, bytes: count(obj(innerOf(error.item))["size"]) }))
							)
						}
					},
					target,
					entry.future
				)

				return { savedPath: created }
			}
			case "uploadFile": {
				const parent = parentOf(spec.parent)

				resize(entry, (await fs.stat(spec.path)).size)
				ensureRunning(entry)

				const file = await client.uploadFile(
					{
						parent,
						name: undefined,
						created: undefined,
						modified: undefined,
						mime: undefined,
						noExif: false,
						noExifOverride: false
					},
					spec.path,
					{ onUpdate: delta => addBytes(entry, delta) },
					entry.future
				)

				return { uploaded: envelopeOf(entry, "File", file) }
			}
			case "uploadDirectory": {
				const parent = parentOf(spec.parent)
				const files = directoryFiles(entry)

				ensureRunning(entry)

				const dir = await client.createDir(parent, spec.name)

				ensureRunning(entry)
				await client.uploadDirRecursively(
					spec.path,
					{
						onScanProgress: (_dirs, knownFiles, knownBytes) => {
							scanned(entry, files, knownFiles, knownBytes)
						},
						onScanErrors: errors => {
							scanFailed(entry, files, errors)
						},
						onScanComplete: (_dirs, totalFiles, totalBytes) => {
							scanned(entry, files, totalFiles, totalBytes)
						},
						onUploadUpdate: (_dirs, uploaded, bytes) => {
							files.done += uploaded.length
							addBytes(entry, bytes)
						},
						onUploadErrors: errors => {
							failed(
								entry,
								files,
								errors.map(error => ({ path: error.path, bytes: 0 }))
							)
						}
					},
					dir,
					entry.future
				)

				return { uploaded: envelopeOf(entry, "Dir", dir) }
			}
		}
	}

	function completed(entry: Entry): DesktopTransferOutcome {
		const files = entry.files

		if (files === null) {
			return "done"
		}

		// Entries the SDK skipped (unsafe names) are in the scan total but neither done nor failed.
		const skipped = entry.scanTotal !== null && entry.scanTotal > files.done + files.failed

		return files.failed > 0 || skipped ? "completedWithErrors" : "done"
	}

	async function run(entry: Entry): Promise<void> {
		let settled: Settled = {}
		let outcome: DesktopTransferOutcome
		let error: DesktopTransferError | undefined

		try {
			settled = await execute(entry)
			outcome = completed(entry)
		} catch (caught) {
			if (entry.cancelled || caught instanceof Cancelled || isCancelled(sdk, caught)) {
				outcome = "cancelled"
			} else {
				outcome = "error"
				error = classifyTransfer(sdk, caught, platform)
				log.warn(`transfer ${entry.id} failed: ${error.code}${error.message === undefined ? "" : `: ${error.message}`}`)

				if (error.code === "unauthenticated" && !authReported) {
					authReported = true
					deps.onAuthFailed()
				}
			}
		}

		await entry.marking
		entries.delete(entry.id)

		if (closed) {
			return
		}

		settles.push({
			k: "settled",
			id: entry.id,
			outcome,
			...(error === undefined ? {} : { error }),
			...(settled.uploaded === undefined ? {} : { uploaded: settled.uploaded }),
			...(settled.savedPath === undefined ? {} : { savedPath: settled.savedPath })
		})
		arm()
	}

	return {
		start: specs => {
			if (closed) {
				return
			}

			authReported = false

			for (const spec of specs) {
				if (entries.has(spec.id)) {
					log.warn(`transfer ${spec.id} is already running`)

					continue
				}

				const controller = new sdk.ManagedAbortController()
				const pause = new sdk.PauseSignal()
				const entry: Entry = {
					id: spec.id,
					spec,
					controller,
					pause,
					future: { abortSignal: controller.signal(), pauseSignal: pause },
					size: 0,
					bytes: 0,
					files: null,
					scanTotal: null,
					dirty: false,
					cancelled: false,
					logged: 0,
					marking: Promise.resolve()
				}

				entries.set(spec.id, entry)
				void run(entry)
			}
		},
		cancel: ids => {
			for (const id of ids) {
				const entry = entries.get(id)

				if (entry !== undefined && !entry.cancelled) {
					entry.cancelled = true
					entry.controller.abort()
				}
			}
		},
		setPaused: (ids, paused) => {
			for (const id of ids) {
				const pause = entries.get(id)?.pause

				if (paused) {
					pause?.pause()
				} else {
					pause?.resume()
				}
			}
		},
		listTree: async ({ listingId, items, maxEntries }) => {
			const tree: NativeTreeEntry[] = []
			const files: unknown[] = []

			pendingListings.add(listingId)

			try {
				for (const [source, item] of items.entries()) {
					const value = ubrnOf(item.ref.variant, parseEnvelope(item.ref.value))

					if (item.ref.variant.startsWith("AnyFile.")) {
						const facts = fileFacts(innerOf(value))

						tree.push({
							segments: [item.name],
							directory: false,
							size: facts.size,
							mtimeMs: facts.mtimeMs,
							listIndex: null,
							source
						})
					} else {
						const listed = await client.listDirRecursiveWithPaths(value, undefined, {
							onErrors: errors => {
								log.warn(`listing ${item.name}: ${String(errors.length)} entries not listed`)
							}
						})
						const known = tree.length + 1 + listed.dirs.length + listed.files.length

						if (known > maxEntries) {
							return { tooMany: known }
						}

						tree.push({ segments: [item.name], directory: true, size: 0, mtimeMs: null, listIndex: null, source })

						for (const dir of listed.dirs) {
							if (dir.path !== "") {
								tree.push({
									segments: [item.name, ...dir.path.split("/")],
									directory: true,
									size: 0,
									mtimeMs: null,
									listIndex: null,
									source
								})
							}
						}

						for (const file of listed.files) {
							const facts = fileFacts(file.file)

							tree.push({
								segments: [item.name, ...file.path.split("/")],
								directory: false,
								size: facts.size,
								mtimeMs: facts.mtimeMs,
								listIndex: files.length,
								source
							})
							files.push(file.file)
						}
					}

					if (tree.length > maxEntries) {
						return { tooMany: tree.length }
					}
				}
			} finally {
				// Released (or aborted) while listing: nothing is held.
				if (!pendingListings.delete(listingId) || closed) {
					files.length = 0
				}
			}

			if (files.length > 0) {
				listings.set(listingId, { files, usedAt: Date.now() })
				arm()
			}

			return { entries: tree }
		},
		releaseTree: listingId => {
			pendingListings.delete(listingId)
			listings.delete(listingId)
		},
		abortAll: () => {
			closed = true

			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}

			for (const entry of entries.values()) {
				entry.cancelled = true
				entry.controller.abort()
			}

			listings.clear()
			pendingListings.clear()
			dirty.clear()
			settles = []
		},
		active: () => entries.size + listings.size
	}
}

export type TransferOpHandlers = { [K in TransfersOp]: (args: NativeOpArgs<K>) => Promise<NativeOpResult<K>> }

export function transferOps(registry: TransferRegistry): TransferOpHandlers {
	return {
		transfersStart: args => {
			registry.start(args.specs)

			return Promise.resolve(null)
		},
		transfersCancel: args => {
			registry.cancel(args.ids)

			return Promise.resolve(null)
		},
		transfersPause: args => {
			registry.setPaused(args.ids, args.paused)

			return Promise.resolve(null)
		},
		transfersListTree: args => registry.listTree(args),
		transfersReleaseTree: args => {
			registry.releaseTree(args.listingId)

			return Promise.resolve(null)
		}
	}
}
