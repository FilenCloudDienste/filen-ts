import { toast } from "sonner"
import type { DesktopSyncError, DesktopSyncResult } from "@filen/shared/desktop"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import { syncErrorKey } from "@/features/sync/lib/syncErrors.logic"

export function syncErrorLabel(error: DesktopSyncError): string {
	return i18n.t(`sync:${syncErrorKey(error)}`)
}

// A sync call whose failure the user only needs to hear about: the error as a toast, null for the caller.
export async function runSyncAction<T>(call: () => Promise<DesktopSyncResult<T>>): Promise<{ value: T } | null> {
	let result: DesktopSyncResult<T>

	try {
		result = await call()
	} catch (error) {
		log.warn("sync", "bridge call failed", error)
		result = { ok: false, error: { code: "unknown" } }
	}

	if (!result.ok) {
		toast.error(syncErrorLabel(result.error))

		return null
	}

	return { value: result.value }
}
