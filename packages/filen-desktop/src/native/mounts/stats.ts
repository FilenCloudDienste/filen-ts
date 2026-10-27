import type { RcloneStats } from "@filen/sdk-rs"
import type { DesktopMountsStats } from "@filen/shared/desktop"
import type { NativeMountsStatus } from "../../shared/nativeProtocol.ts"
import { clip } from "../errors.ts"

// While a page shows the stats.
export const SUBSCRIBED_POLL_MS = 1000
// While rclone runs and nobody looks: the tray's uploads and a drive lost under it.
export const IDLE_POLL_MS = 5000

export const EMPTY_STATS: DesktopMountsStats = { transfers: [], uploadsInProgress: 0, uploadsQueued: 0 }

function count(value: bigint | number): number {
	return Math.min(Math.max(0, Math.floor(Number(value))), Number.MAX_SAFE_INTEGER)
}

export function mountsStats(stats: RcloneStats): DesktopMountsStats {
	return {
		transfers: stats.transfers.map(transfer => ({
			name: clip(transfer.name),
			bytes: count(transfer.bytes),
			total: count(transfer.size ?? 0n),
			speed: count(transfer.speedBps)
		})),
		uploadsInProgress: count(stats.uploadsInProgress),
		uploadsQueued: count(stats.uploadsQueued)
	}
}

export function uploadsOf(stats: RcloneStats): NonNullable<NativeMountsStatus["uploads"]> {
	return { pending: count(stats.uploadsInProgress) + count(stats.uploadsQueued), errored: count(stats.erroredFiles) }
}

// A mount point as rclone and the OS spell it: without a trailing separator, and on Windows case-insensitive.
export function sameMountPoint(a: string, b: string, platform: NodeJS.Platform): boolean {
	const normal = (value: string) => {
		const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, "") : value

		return platform === "win32" ? trimmed.toUpperCase() : trimmed
	}

	return normal(a) === normal(b)
}

export interface StatsPoller {
	// Re-reads the cadence: call after anything it depends on changed.
	refresh(): void
	stop(): void
}

// One read at a time, the next scheduled only once the last one finished, at the cadence `interval` names now; none
// while it names null.
export function createStatsPoller(interval: () => number | null, tick: () => Promise<void>): StatsPoller {
	let timer: NodeJS.Timeout | null = null
	let due = 0
	let reading = false
	let stopped = false

	function schedule(): void {
		const ms = stopped || reading ? null : interval()

		if (ms === null) {
			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}

			return
		}

		const at = Date.now() + ms

		// A pending read that comes sooner stays.
		if (timer !== null) {
			if (due <= at) {
				return
			}

			clearTimeout(timer)
		}

		due = at
		timer = setTimeout(() => {
			timer = null
			reading = true
			void tick().finally(() => {
				reading = false
				schedule()
			})
		}, ms)
	}

	return {
		refresh: schedule,
		stop: () => {
			stopped = true
			schedule()
		}
	}
}
