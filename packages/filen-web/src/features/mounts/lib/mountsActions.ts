import { toast } from "sonner"
import type { DesktopMountsError, DesktopMountsResult } from "@filen/shared/desktop"
import { i18n } from "@/lib/i18n"
import { log } from "@/lib/log"
import { mountsErrorKey } from "@/features/mounts/lib/mountsErrors.logic"

export function mountsErrorLabel(error: DesktopMountsError): string {
	return i18n.t(`mounts:${mountsErrorKey(error)}`)
}

// A failed bridge call reads as `unknown`.
export async function callMounts<T>(call: () => Promise<DesktopMountsResult<T>>): Promise<DesktopMountsResult<T>> {
	try {
		return await call()
	} catch (error) {
		log.warn("mounts", "bridge call failed", error)

		return { ok: false, error: { code: "unknown" } }
	}
}

// A mounts call whose failure the user only needs to hear about: the error as a toast, null for the caller.
export async function runMountsAction<T>(call: () => Promise<DesktopMountsResult<T>>): Promise<{ value: T } | null> {
	const result = await callMounts(call)

	if (!result.ok) {
		toast.error(mountsErrorLabel(result.error))

		return null
	}

	return { value: result.value }
}
