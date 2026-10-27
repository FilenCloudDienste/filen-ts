import type {
	DesktopDrive,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopMountsStats,
	DesktopServe,
	DesktopSyncPair
} from "@filen/shared/desktop"

// Transfers the desktop app runs outside this page: its sync engine's and its rclone's (the network drive and the
// servers). They are listed live beside the page's own and never enter the transfers store: they have no controls,
// no history and nothing to clear.

// A mounts source of null: the drive and the writable servers share one rclone remote and VFS cache, so its stats name
// no role; they are told apart only while a single role could have made them.
export type ExternalTransferSource = { kind: "sync"; pairId: string; name: string } | { kind: "mounts"; role: DesktopMountsRole | null }

export interface ExternalTransfer {
	kind: "transfer"
	id: string
	// The file's path in its pair or in the drive.
	path: string
	direction: "upload" | "download"
	bytes: number
	// 0 while unknown.
	total: number
	// Bytes per second; null where the source reports none (sync).
	speed: number | null
	source: ExternalTransferSource
}

// The drive cache's uploads that wait their turn; rclone counts them without naming them.
export interface ExternalQueuedUploads {
	kind: "queued"
	id: string
	count: number
	source: ExternalTransferSource
}

export type ExternalTransferRow = ExternalTransfer | ExternalQueuedUploads

export function syncTransferRows(pairs: readonly DesktopSyncPair[] | undefined): ExternalTransfer[] {
	const rows: ExternalTransfer[] = []

	for (const pair of pairs ?? []) {
		for (const transfer of pair.transfers) {
			rows.push({
				kind: "transfer",
				id: `sync:${pair.id}:${transfer.direction}:${transfer.relPath}`,
				path: transfer.relPath,
				direction: transfer.direction,
				bytes: transfer.bytes,
				total: transfer.total,
				speed: null,
				source: { kind: "sync", pairId: pair.id, name: pair.name }
			})
		}
	}

	return rows
}

export interface MountsAttribution {
	// The role rclone's transfers belong to: the one role running.
	transfers: DesktopMountsRole | null
	// The role the cache's uploads belong to: the one writable role running, as a read-only role writes nothing.
	uploads: DesktopMountsRole | null
}

// A stopping role still finishes what it moves.
function live(state: DesktopMountsRoleState): boolean {
	return state === "running" || state === "stopping"
}

export function attributeMounts(drive: DesktopDrive | undefined, serves: readonly DesktopServe[] | undefined): MountsAttribution {
	const running: { role: DesktopMountsRole; readOnly: boolean }[] = []

	if (drive !== undefined && live(drive.state)) {
		running.push({ role: "drive", readOnly: drive.readOnly })
	}

	for (const serve of serves ?? []) {
		if (live(serve.state)) {
			running.push({ role: serve.protocol, readOnly: serve.readOnly })
		}
	}

	const writable = running.filter(entry => !entry.readOnly)

	return {
		transfers: running.length === 1 ? (running[0]?.role ?? null) : null,
		uploads: writable.length === 1 ? (writable[0]?.role ?? null) : null
	}
}

// Whether a role runs, and so whether rclone's stats are worth following.
export function mountsRunning(drive: DesktopDrive | undefined, serves: readonly DesktopServe[] | undefined): boolean {
	return (drive !== undefined && live(drive.state)) || (serves ?? []).some(serve => live(serve.state))
}

// rclone's running transfers are the cache's uploads, as the drive page words them; a name rclone lists twice shows once.
export function mountsTransferRows(stats: DesktopMountsStats | null, attribution: MountsAttribution): ExternalTransferRow[] {
	if (stats === null) {
		return []
	}

	const rows: ExternalTransferRow[] = []
	const seen = new Set<string>()

	for (const transfer of stats.transfers) {
		if (seen.has(transfer.name)) {
			continue
		}

		seen.add(transfer.name)
		rows.push({
			kind: "transfer",
			id: `mounts:${transfer.name}`,
			path: transfer.name,
			direction: "upload",
			bytes: transfer.bytes,
			total: transfer.total,
			speed: transfer.speed,
			source: { kind: "mounts", role: attribution.transfers }
		})
	}

	if (stats.uploadsQueued > 0) {
		rows.push({
			kind: "queued",
			id: "mounts:queued",
			count: stats.uploadsQueued,
			source: { kind: "mounts", role: attribution.uploads }
		})
	}

	return rows
}

// What the rail's transfers ring takes from the sync overview, which reaches the page without asking: the transfers in
// flight, and their bytes. (Of the mounts it takes the mounts overview's pending upload count, refreshed every few seconds
// by the shell's idle look at rclone; their bytes would take the stats subscription.)
export interface SyncActivity {
	count: number
	// Over the transfers of known size.
	bytes: number
	total: number
}

export const NO_SYNC_ACTIVITY: SyncActivity = { count: 0, bytes: 0, total: 0 }

export function syncActivity(pairs: readonly DesktopSyncPair[] | undefined): SyncActivity {
	let count = 0
	let bytes = 0
	let total = 0

	for (const pair of pairs ?? []) {
		for (const transfer of pair.transfers) {
			count++

			if (transfer.total > 0) {
				bytes += Math.min(transfer.bytes, transfer.total)
				total += transfer.total
			}
		}
	}

	return { count, bytes, total }
}
