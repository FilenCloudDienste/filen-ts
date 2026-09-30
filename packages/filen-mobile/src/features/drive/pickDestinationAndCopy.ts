import type { DriveItem } from "@/types"
import { run } from "@filen/shared"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import { selectCopyDestination } from "@/features/drive/driveSelectSession"

// Picks a destination directory and starts a copy job into it. True once the job started; false when
// the picker was dismissed or either step failed (already logged and alerted).
export async function pickDestinationAndCopy({
	pickerItems,
	start,
	logTag,
	label,
	count
}: {
	pickerItems: DriveItem[]
	start: (picked: NonNullable<Awaited<ReturnType<typeof selectCopyDestination>>>) => unknown
	logTag: string
	label: string
	count: number
}): Promise<boolean> {
	const picked = await run(async () => {
		return await selectCopyDestination(pickerItems)
	})

	if (!picked.success) {
		logger.error(logTag, `${label}: destination picker failed`, { error: picked.error })
		alerts.error(picked.error)

		return false
	}

	if (!picked.data) {
		return false
	}

	const destination = picked.data
	const started = await run(async () => {
		return start(destination)
	})

	if (!started.success) {
		logger.error(logTag, `${label}: failed to start`, { error: started.error, count })
		alerts.error(started.error)

		return false
	}

	return true
}
