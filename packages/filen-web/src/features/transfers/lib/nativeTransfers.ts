import type { Dir, File as SdkFile } from "@filen/sdk-rs"
import type { DesktopTransfer, DesktopTransferEvent, DesktopTransferProgress } from "@filen/shared/desktop"
import { parseEnvelope } from "@filen/shared/session"
import { desktopBridge } from "@/lib/desktop"
import { log } from "@/lib/log"
import { toastSummary } from "@/lib/actions/bulkToast"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import {
	defaultUploadDeps,
	invalidateUploadedDirectorySizes,
	landUpload,
	newUploadBatchRef,
	reactToStorageRefusal
} from "@/features/drive/lib/upload"
import { toastDownloadFailed } from "@/features/transfers/lib/settle"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"
import { errorDtoOf, rowOf } from "@/features/transfers/lib/nativeTransfers.logic"
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

// On desktop, once the signed-in shell started the feed.
export function nativeTransfersAvailable(): boolean {
	return unsubscribe !== null
}

function stop(): void {
	unsubscribe?.()
	unsubscribe = null
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

	return stop
}

function storeRow(id: string): Transfer | undefined {
	return transferById(useTransfersStore.getState().transfers, id)
}

// The runs, rows and figures `transfers` add to the store, and their groups registered.
function planAdded(transfers: readonly DesktopTransfer[]): Pick<NativeTransfersChange, "runs" | "add" | "progress"> {
	const runs: NonNullable<NativeTransfersChange["runs"]>[number][] = []
	const add: Transfer[] = []
	const progress: DesktopTransferProgress[] = []
	const plain = new Map<string, { group: Group; files: number; bytes: number; transferred: number; startedAt: number }>()

	for (const transfer of transfers) {
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

// The group's end, after the store update: its sizes, storage and summary, as the page's own uploads end.
function endGroup(group: Group): void {
	if (group.direction === "download") {
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
			: { complete: "transfers:transfersUploadSummaryComplete", withFailures: "transfers:transfersUploadSummaryCompleteWithFailures" }
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
		if (storeRow(transfer.id) === undefined) {
			fresh.push(transfer)
		} else {
			known.push(transfer)
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

	if (row.direction === "download" && event.outcome === "error") {
		toastDownloadFailed({})
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
