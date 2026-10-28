import { useSyncExternalStore } from "react"
import { driveItemName, isDotFilenName, isRootDotFilen, type SourceDisposalKind } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { accountQueryGet } from "@/queries/account"
import { knownDotFilenUuid } from "@/lib/dotFilen"

// Trashing, deleting, moving or renaming the root `.filen` (Filen's own synced settings) is never blocked, only
// confirmed by typing its name (components/dotFilenConfirmDialog.tsx). Trash, delete and rename confirm inside the
// listing's dialog host; a move confirms when it runs, through ask() below and the one dialog mounted at the root.

export type DotFilenOperation = "trash" | "delete" | "move" | "rename"

// By the uuid the resolver holds, else by name and place. A trashed directory's parent reads "trash" (where it came
// from is lost), so any trashed `.filen` counts: guarding a nested one too is the cheaper mistake.
export function isRootDotFilenItem(item: DriveItem): boolean {
	if (item.type !== "directory") {
		return false
	}

	if (item.data.uuid === knownDotFilenUuid()) {
		return true
	}

	const name = driveItemName(item)

	return item.data.parent === "trash"
		? isDotFilenName(name)
		: isRootDotFilen({ name, parentUuid: item.data.parent, rootUuid: accountQueryGet()?.rootDirUuid ?? null })
}

export function includesRootDotFilen(items: readonly DriveItem[]): boolean {
	return items.some(isRootDotFilenItem)
}

// A job that removes its sources afterwards (Compress → trash or delete) disposes of them as the operation would.
export function disposalOperation(dispose: SourceDisposalKind): "trash" | "delete" {
	return dispose === "trash" ? "trash" : "delete"
}

export interface DotFilenAsk {
	readonly operation: DotFilenOperation
	// `.filen` is one of several items: the dialog says that proceeding includes it.
	readonly multiple: boolean
	readonly settle: (confirmed: boolean) => void
}

let current: DotFilenAsk | null = null
const listeners = new Set<() => void>()

function publish(next: DotFilenAsk | null): void {
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

function currentAsk(): DotFilenAsk | null {
	return current
}

export function useDotFilenAsk(): DotFilenAsk | null {
	return useSyncExternalStore(subscribe, currentAsk, currentAsk)
}

// The asks waiting their turn behind the one shown.
let queue: Promise<unknown> = Promise.resolve()

// True to go on: `items` hold no root `.filen`, or the user typed its name. One prompt at a time.
export function confirmDotFilenOperation(operation: DotFilenOperation, items: readonly DriveItem[]): Promise<boolean> {
	if (!includesRootDotFilen(items)) {
		return Promise.resolve(true)
	}

	const asked = queue.then(
		() =>
			new Promise<boolean>(resolve => {
				const ask: DotFilenAsk = {
					operation,
					multiple: items.length > 1,
					settle: confirmed => {
						if (current === ask) {
							publish(null)
							resolve(confirmed)
						}
					}
				}

				publish(ask)
			})
	)

	queue = asked

	return asked
}
