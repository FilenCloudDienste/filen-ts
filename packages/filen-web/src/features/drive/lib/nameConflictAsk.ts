import { useSyncExternalStore } from "react"
import { i18n } from "@/lib/i18n"
import { accountQueryGet } from "@/queries/account"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { claimParent } from "@/features/drive/lib/uploadClaims"
import type { ConflictAnswer, ConflictOperation, NameConflict } from "@/features/drive/lib/nameConflicts"

// The conflict prompt of an upload or a move, answered in the one dialog mounted at the root
// (components/nameConflictDialog.tsx): an upload started from a drop or a paste has no dialog of its own to host it.

export interface NameConflictAsk {
	readonly id: string
	readonly operation: ConflictOperation
	// The directory written into, by name.
	readonly destination: string
	readonly conflicts: readonly NameConflict[]
	// Whether a replaced file's previous version stays in its versions (the account's setting).
	readonly versioning: boolean
	// null: dismissed, every conflict skipped.
	readonly settle: (answer: ConflictAnswer | null) => void
}

let current: NameConflictAsk | null = null
const listeners = new Set<() => void>()

function publish(next: NameConflictAsk | null): void {
	current = next

	for (const listener of listeners) {
		listener()
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)

	return () => {
		listeners.delete(listener)
	}
}

function currentAsk(): NameConflictAsk | null {
	return current
}

export function useNameConflictAsk(): NameConflictAsk | null {
	return useSyncExternalStore(subscribe, currentAsk, currentAsk)
}

// The name a directory is shown by in the prompt: from the cache, never a request.
export function destinationLabel(parentUuid: string | null): string {
	const parent = claimParent(parentUuid)

	if (parent === null) {
		return i18n.t("drive:driveMyDrive")
	}

	return cachedDirectoryName(parent) ?? i18n.t("drive:driveMoveDestinationFallback")
}

// The asks waiting their turn behind the one shown.
let queue: Promise<unknown> = Promise.resolve()

// The user's answer to `conflicts` (never empty), null when the prompt was dismissed. One prompt at a time.
export function askNameConflicts({
	operation,
	parentUuid,
	conflicts
}: {
	operation: ConflictOperation
	parentUuid: string | null
	conflicts: readonly NameConflict[]
}): Promise<ConflictAnswer | null> {
	const asked = queue.then(
		() =>
			new Promise<ConflictAnswer | null>(resolve => {
				const ask: NameConflictAsk = {
					id: crypto.randomUUID(),
					operation,
					destination: destinationLabel(parentUuid),
					conflicts,
					versioning: accountQueryGet()?.versioningEnabled !== false,
					settle: answer => {
						if (current === ask) {
							publish(null)
							resolve(answer)
						}
					}
				}

				publish(ask)
			})
	)

	queue = asked

	return asked
}
