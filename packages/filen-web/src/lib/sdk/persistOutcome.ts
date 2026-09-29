import type { StringifiedClient } from "@filen/sdk-rs"
import { asErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

// Worker-free on purpose: the attempt runners inject their collaborators and are unit-tested without
// the sdkApi client, so this must not import it.
export interface PersistSessionDeps {
	persist: (blob: StringifiedClient) => Promise<void>
	// Supplied only by credential mutations: the pre-mutation blob on disk is dead once persisting the
	// new one fails.
	clearSession?: () => Promise<void>
}

// Best-effort session save after a call that already SUCCEEDED, so a failure is reported as `false`,
// never thrown. A null blob (the session could not even be re-read) counts as a failure. On failure
// the stale session is cleared when `clearSession` is given, itself best-effort: a stale blob is the
// worst case either way.
export async function persistSessionBlob(
	deps: PersistSessionDeps,
	blob: StringifiedClient | null,
	scope: string,
	label: string
): Promise<boolean> {
	if (blob !== null) {
		try {
			await deps.persist(blob)
			return true
		} catch (e) {
			log.warn(scope, `${label} persist failed`, asErrorDTO(e))
		}
	}

	if (deps.clearSession) {
		try {
			await deps.clearSession()
		} catch (e) {
			log.warn(scope, `clearing stale session after ${label} persist failure failed`, asErrorDTO(e))
		}
	}

	return false
}
