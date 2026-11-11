import type { Dir, File as SdkFile } from "@filen/sdk-rs"
import { toast } from "sonner"
import type {
	DesktopTransfer,
	DesktopTransferEvent,
	DesktopTransferKind,
	DesktopTransferProgress,
	DesktopUploadParent
} from "@filen/shared/desktop"
import { parseEnvelope } from "@filen/shared/session"
import { sumBytes } from "@filen/shared"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { toastSummary } from "@/lib/actions/bulkToast"
import { accountQueryGet } from "@/queries/account"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { findCachedListingItem } from "@/features/drive/queries/drive"
import {
	defaultHeicUploadDeps,
	heicUploadConversionEnabled,
	isHeicUploadCandidate,
	isHeicUploadName
} from "@/features/drive/lib/heicUpload"
import { ensureUploadQuota } from "@/features/drive/lib/quota"
import {
	defaultUploadDeps,
	invalidateUploadedDirectorySizes,
	landUpload,
	newUploadBatchRef,
	reactToStorageRefusal,
	startUploads
} from "@/features/drive/lib/upload"
import { isDirectoryEntry, readEntriesBatch, startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"
import { errorDtoOf, rowOf, uploadParentOf } from "@/features/transfers/lib/nativeTransfers.logic"
import { NATIVE_FAILURE_TOAST_ID, nativeFeedChanged, toastNativeFailure } from "@/features/transfers/lib/nativeHost"
import {
	isActiveTransfer,
	transferById,
	useTransfersStore,
	type NativeTransfersChange,
	type Transfer,
	type UploadBatchRef
} from "@/features/transfers/store/useTransfersStore"

// The desktop app's native transfers in the page's transfers store: main runs them in its native host and reports
// every change as an event (snapshot first), which lands in the store in one update. Uploads of one call form one
// group: its files one upload run, each directory a run of its own, and the group's end reads as the page's own
// uploads do (sizes, storage, the summary toast).

interface Group {
	direction: DesktopTransfer["direction"]
	// The listing's parent, null for the root.
	listingParent: string | null
	// The plain run of the group's files.
	run: UploadBatchRef | undefined
	pending: Set<string>
	directories: boolean
	succeeded: number
	failed: number
	created: string[]
	storageFull: boolean
}

const groups = new Map<string, Group>()
// Row id → its group.
const groupOf = new Map<string, string>()
let unsubscribe: (() => void) | null = null

function stop(): void {
	unsubscribe?.()
	unsubscribe = null
	nativeFeedChanged(false)
	groups.clear()
	groupOf.clear()
}

// Idempotent; the returned stop ends the feed for whoever started it.
export function startNativeTransfersFeed(): () => void {
	const bridge = desktopBridge()

	if (bridge === undefined) {
		return () => undefined
	}

	unsubscribe ??= bridge.transfers.onEvents(applyNativeEvent)
	nativeFeedChanged(true)

	return stop
}

function storeRow(id: string): Transfer | undefined {
	return transferById(useTransfersStore.getState().transfers, id)
}

// Registers the row in its group, the group first when new.
function joinGroup(transfer: DesktopTransfer): Group {
	let group = groups.get(transfer.group)

	if (group === undefined) {
		group = {
			direction: transfer.direction,
			listingParent: newUploadBatchRef(transfer.parentUuid).parentUuid,
			run: undefined,
			pending: new Set(),
			directories: false,
			succeeded: 0,
			failed: 0,
			created: [],
			storageFull: false
		}
		groups.set(transfer.group, group)
	}

	group.pending.add(transfer.id)
	groupOf.set(transfer.id, transfer.group)

	return group
}

// The runs, rows and figures `transfers` add to the store, and their groups registered.
function planAdded(transfers: readonly DesktopTransfer[]): Pick<NativeTransfersChange, "runs" | "add" | "progress"> {
	const runs: NonNullable<NativeTransfersChange["runs"]>[number][] = []
	const add: Transfer[] = []
	const progress: DesktopTransferProgress[] = []
	const plain = new Map<string, { group: Group; files: number; bytes: number; transferred: number; startedAt: number }>()

	for (const transfer of transfers) {
		const group = joinGroup(transfer)

		if (transfer.direction === "download") {
			add.push({ ...rowOf(transfer, undefined), paused: transfer.paused })

			continue
		}

		if (transfer.kind === "directory") {
			group.directories = true
			runs.push({
				ref: { ...newUploadBatchRef(transfer.parentUuid, transfer.name, transfer.id), native: true },
				totals: { files: 0, bytes: transfer.size },
				scanning: true,
				startedAt: transfer.startedAt,
				paused: transfer.paused
			})
			progress.push({ id: transfer.id, size: transfer.size, bytes: transfer.bytes, files: transfer.files })

			continue
		}

		group.run ??= { ...newUploadBatchRef(transfer.parentUuid, undefined, transfer.group), native: true }

		const sized = plain.get(transfer.group) ?? { group, files: 0, bytes: 0, transferred: 0, startedAt: transfer.startedAt }

		sized.files++
		sized.bytes += transfer.size
		sized.transferred += transfer.bytes
		plain.set(transfer.group, sized)
		add.push({ ...rowOf(transfer, group.run), paused: transfer.paused })
	}

	for (const { group, files, bytes, transferred, startedAt } of plain.values()) {
		if (group.run !== undefined) {
			runs.push({ ref: group.run, totals: { files, bytes }, scanning: false, startedAt, paused: false, transferred })
		}
	}

	return { runs, add, progress }
}

function toastDragStarts(transfers: readonly DesktopTransfer[]): void {
	const counts = new Map<string, { name: string; count: number }>()

	for (const transfer of transfers) {
		if (transfer.origin === "drag") {
			const start = counts.get(transfer.group) ?? { name: transfer.name, count: 0 }

			start.count++
			counts.set(transfer.group, start)
		}
	}

	for (const { name, count } of counts.values()) {
		toastTransferStarted({ direction: "download", name, count, noun: "items" })
	}
}

// The group's end, after the store update: its sizes, storage and summary, as the page's own uploads end. Downloads
// say only that some failed.
function endGroup(group: Group): void {
	if (group.direction === "download") {
		if (group.failed > 0) {
			toast.error(
				i18n.t("transfers:transfersDownloadSummaryCompleteWithFailures", { count: group.succeeded, failed: group.failed }),
				{ id: NATIVE_FAILURE_TOAST_ID }
			)
		}

		return
	}

	if (group.succeeded > 0 || group.created.length > 0) {
		invalidateUploadedDirectorySizes(group.listingParent, group.created)
	}

	toastSummary(
		group.succeeded,
		group.failed,
		group.directories
			? {
					complete: "transfers:transfersDirectoryUploadSummaryComplete",
					withFailures: "transfers:transfersDirectoryUploadSummaryCompleteWithFailures"
				}
			: {
					complete: "transfers:transfersUploadSummaryComplete",
					withFailures: "transfers:transfersUploadSummaryCompleteWithFailures"
				},
		NATIVE_FAILURE_TOAST_ID
	)

	if (group.storageFull) {
		reactToStorageRefusal()
	}
}

// Removes ended rows from their groups; returns the groups that ended and the plain runs to end with them.
function leaveGroups(ids: Iterable<string>): { ended: Group[]; runs: string[] } {
	const ended: Group[] = []
	const runs: string[] = []

	for (const id of ids) {
		const groupId = groupOf.get(id)
		const group = groupId === undefined ? undefined : groups.get(groupId)

		groupOf.delete(id)

		if (groupId === undefined || group === undefined || !group.pending.delete(id) || group.pending.size > 0) {
			continue
		}

		groups.delete(groupId)
		ended.push(group)

		if (group.run !== undefined) {
			runs.push(group.run.id)
		}
	}

	return { ended, runs }
}

function decoded(uploaded: string | undefined): unknown {
	if (uploaded === undefined) {
		return undefined
	}

	try {
		const value = parseEnvelope(uploaded)

		return typeof value === "object" && value !== null && "uuid" in value && typeof value.uuid === "string" ? value : undefined
	} catch (e) {
		log.warn("transfers.native", "unreadable uploaded item", e)

		return undefined
	}
}

function applySnapshot(transfers: readonly DesktopTransfer[]): void {
	const listed = new Set(transfers.map(transfer => transfer.id))
	const drop = new Set<string>()

	for (const row of useTransfersStore.getState().transfers) {
		if (row.native === true && isActiveTransfer(row.status) && !listed.has(row.id)) {
			drop.add(row.id)
		}
	}

	const fresh: DesktopTransfer[] = []
	const known: DesktopTransfer[] = []

	for (const transfer of transfers) {
		const row = storeRow(transfer.id)

		if (row === undefined) {
			fresh.push(transfer)

			continue
		}

		known.push(transfer)

		// A restarted feed lost its groups; their active rows rejoin them.
		if (!groupOf.has(transfer.id) && isActiveTransfer(row.status)) {
			const group = joinGroup(transfer)

			if (transfer.direction === "upload" && transfer.kind === "directory") {
				group.directories = true
			} else if (transfer.direction === "upload") {
				group.run ??= row.batch
			}
		}
	}

	const planned = planAdded(fresh)
	const { ended, runs } = leaveGroups(drop)

	useTransfersStore.getState().applyNativeChange({
		drop,
		...planned,
		progress: [
			...(planned.progress ?? []),
			...known.map(transfer => ({ id: transfer.id, size: transfer.size, bytes: transfer.bytes, files: transfer.files }))
		],
		paused: new Map(known.map(transfer => [transfer.id, transfer.paused])),
		end: runs
	})

	for (const group of ended) {
		endGroup(group)
	}
}

function applySettled(event: Extract<DesktopTransferEvent, { t: "settled" }>): void {
	const row = storeRow(event.id)
	const groupId = groupOf.get(event.id)
	const group = groupId === undefined ? undefined : groups.get(groupId)

	if (row === undefined || !isActiveTransfer(row.status)) {
		leaveGroups([event.id])

		return
	}

	const error = event.error === undefined ? undefined : errorDtoOf(event.error)
	const landed = event.outcome === "done" || event.outcome === "completedWithErrors"
	const uploaded = row.direction === "upload" && landed ? decoded(event.uploaded) : undefined
	const item: DriveItem | undefined = uploaded === undefined ? undefined : narrowItem(uploaded as SdkFile | Dir)
	const directory = row.batch?.id === row.id
	const listingParent = row.batch?.parentUuid ?? null

	if (group !== undefined) {
		if (directory) {
			const run = useTransfersStore.getState().uploadBatches[row.id]
			const files = run?.files ?? 0
			const done = Math.max(0, (run?.settledFiles ?? 0) - (run?.failed ?? 0))

			group.succeeded += landed ? done : 0
			group.failed += event.outcome === "cancelled" ? 0 : Math.max(run?.failed ?? 0, files - done, landed ? 0 : 1)

			if (item !== undefined) {
				group.created.push(item.data.uuid)
			}
		} else if (event.outcome === "done") {
			group.succeeded++
		} else if (event.outcome !== "cancelled") {
			group.failed++
		}

		group.storageFull ||= event.error?.code === "storageFull"
	}

	const { ended, runs } = leaveGroups([event.id])

	useTransfersStore.getState().applyNativeChange({
		settle: { id: event.id, status: event.outcome, ...(error === undefined ? {} : { error }), ...(item === undefined ? {} : { item }) },
		end: runs
	})

	if (item !== undefined) {
		if (directory) {
			defaultUploadDeps.patchCreated(listingParent, item)
			defaultUploadDeps.markAccountStale?.()
		} else {
			landUpload(defaultUploadDeps, listingParent, uploaded as SdkFile)
		}
	}

	for (const endedGroup of ended) {
		endGroup(endedGroup)
	}
}

// One event, one store update (and what follows it outside the store).
export function applyNativeEvent(event: DesktopTransferEvent): void {
	switch (event.t) {
		case "snapshot":
			applySnapshot(event.transfers)
			break
		case "added":
			useTransfersStore
				.getState()
				.applyNativeChange(planAdded(event.transfers.filter(transfer => storeRow(transfer.id) === undefined)))
			toastDragStarts(event.transfers)
			break
		case "progress":
			useTransfersStore.getState().applyNativeProgress(event.updates)
			break
		case "paused":
			useTransfersStore.getState().setPausedMany(new Set(event.ids), event.paused)
			break
		case "settled":
			applySettled(event)
			break
	}
}

// ---------------------------------------------------------------------------
// Entry points: uploads, the upload menu's pickers and drops (downloads: nativeHost.ts). What stays on the page's own
// path: HEIC files, and picked or dropped directories holding one, while they convert on upload.
// ---------------------------------------------------------------------------

// The directory uploads land in, null for the root (the account's root directory); null, said, while that is unknown.
function uploadParent(parentUuid: string | null): DesktopUploadParent | null {
	const uuid = parentUuid ?? accountQueryGet()?.rootDirUuid

	if (uuid === undefined) {
		toastNativeFailure({ code: "invalidItem" })

		return null
	}

	return uploadParentOf(uuid, findCachedListingItem(uuid))
}

async function uploadNatively(files: File[], parentUuid: string | null, noun: "files" | "items"): Promise<void> {
	const bridge = desktopBridge()
	const parent = bridge === undefined || files.length === 0 ? null : uploadParent(parentUuid)

	if (bridge === undefined || parent === null) {
		return
	}

	const convertHeic = await heicUploadConversionEnabled(defaultHeicUploadDeps, files)
	const web = convertHeic ? files.filter(isHeicUploadCandidate) : []
	const native = convertHeic ? files.filter(file => !isHeicUploadCandidate(file)) : files
	const uploads: Promise<void>[] = web.length === 0 ? [] : [startUploads(web, parentUuid)]

	// Plain files keep the page's quota check; a directory's size the host learns only as it reads it.
	if (native.length > 0 && (await ensureUploadQuota(sumBytes(native.map(file => file.size))))) {
		try {
			const result = await bridge.transfers.upload(native, parent)

			if (!result.ok) {
				toastNativeFailure(result.error)
			} else if (result.value.status === "started") {
				// Files without a path the host can read upload from the page.
				const skipped = result.value.skipped.flatMap(index => native[index] ?? [])
				const [first] = native

				if (skipped.length > 0) {
					uploads.push(startUploads(skipped, parentUuid))
				}

				if (first !== undefined && result.value.ids.length > 0) {
					toastTransferStarted({ direction: "upload", name: first.name, count: result.value.ids.length, noun })
				}
			}
		} catch (e) {
			toast.error(errorLabel(e))
		}
	}

	await Promise.all(uploads)
}

// Picked files, or (`asDirectory`) one webkitdirectory input's contents, which upload as one directory.
export async function startNativeUploads(files: File[], parentUuid: string | null, options?: { asDirectory?: boolean }): Promise<void> {
	if (options?.asDirectory !== true) {
		await uploadNatively(files, parentUuid, "files")

		return
	}

	const bridge = desktopBridge()
	const parent = bridge === undefined || files.length === 0 ? null : uploadParent(parentUuid)

	if (bridge === undefined || parent === null) {
		return
	}

	// A directory holding a HEIC file that converts takes the page's walk, whole.
	if (await heicUploadConversionEnabled(defaultHeicUploadDeps, files)) {
		await startDirectoryUpload({ kind: "files", files }, parentUuid)

		return
	}

	try {
		const result = await bridge.transfers.upload(files, parent, { asDirectory: true })

		if (!result.ok) {
			toastNativeFailure(result.error)
		} else if (result.value.status === "started" && result.value.skipped.length > 0) {
			// Main could not read the picked directory: the page's walk uploads it.
			await startDirectoryUpload({ kind: "files", files }, parentUuid)
		} else if (result.value.status === "started" && result.value.ids.length > 0) {
			toastTransferStarted({ direction: "upload", name: storeRow(result.value.ids[0] ?? "")?.name ?? "", count: 1, noun: "items" })
		}
	} catch (e) {
		toast.error(errorLabel(e))
	}
}

// The upload menu's pickers with HEIC conversion off: main's own open dialog, its paths straight to the host. Never
// rejects; settles once the dialog closed and the upload started.
export async function pickNativeUpload(kind: DesktopTransferKind, parentUuid: string | null): Promise<void> {
	const bridge = desktopBridge()
	const parent = bridge === undefined ? null : uploadParent(parentUuid)

	if (bridge === undefined || parent === null) {
		return
	}

	try {
		const result = await bridge.transfers.pickUpload(kind, parent)

		if (!result.ok) {
			toastNativeFailure(result.error)
		} else if (result.value.status === "started" && result.value.ids.length > 0) {
			const ids = result.value.ids

			toastTransferStarted({ direction: "upload", name: storeRow(ids[0] ?? "")?.name ?? "", count: ids.length, noun: "items" })
		}
	} catch (e) {
		toast.error(errorLabel(e))
	}
}

// Whether a dropped directory's tree holds a HEIC file, by its entries' names, stopping at the first. One it cannot
// read counts as holding one: the page's walk then reports what it could not read.
async function holdsHeic(root: FileSystemDirectoryEntry): Promise<boolean> {
	const stack = [root]

	try {
		for (let dir = stack.pop(); dir !== undefined; dir = stack.pop()) {
			const reader = dir.createReader()

			for (let batch = await readEntriesBatch(reader); batch.length > 0; batch = await readEntriesBatch(reader)) {
				for (const child of batch) {
					if (isDirectoryEntry(child)) {
						stack.push(child)
					} else if (isHeicUploadName(child.name)) {
						return true
					}
				}
			}
		}
	} catch {
		return true
	}

	return false
}

// A drop: its top-level Files (a directory among them uploads whole, main stats its path) and their entries, read
// while the drop event held them. With HEIC conversion on, a directory holding a HEIC file takes the page's walk; the
// rest go to the host by their top-level File (its path, never an entry-walked File's).
export async function startNativeDrop(files: File[], entries: readonly FileSystemEntry[], parentUuid: string | null): Promise<void> {
	const directories = entries.filter(isDirectoryEntry)

	if (directories.length === 0 || !(await convertsHeic())) {
		await uploadNatively(files, parentUuid, "items")

		return
	}

	const byName = new Map<string, File[]>()

	for (const file of files) {
		byName.set(file.name, [...(byName.get(file.name) ?? []), file])
	}

	const walked: FileSystemEntry[] = []
	const native: File[] = []

	for (const entry of entries) {
		const file = byName.get(entry.name)?.shift()

		if (isDirectoryEntry(entry) && (await holdsHeic(entry))) {
			walked.push(entry)
		} else if (file !== undefined) {
			native.push(file)
		}
	}

	await Promise.all([
		walked.length === 0 ? undefined : startDirectoryUpload({ kind: "entries", entries: walked }, parentUuid),
		native.length === 0 ? undefined : uploadNatively(native, parentUuid, "items")
	])
}

async function convertsHeic(): Promise<boolean> {
	try {
		return await defaultHeicUploadDeps.readPreference()
	} catch {
		return false
	}
}
