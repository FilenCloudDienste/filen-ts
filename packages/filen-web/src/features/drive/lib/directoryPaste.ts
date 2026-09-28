import { onlineManager } from "@tanstack/react-query"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { canPasteIntoDirectory, type DirectoryPasteTarget } from "@/features/drive/lib/clipboard.logic"
import { pasteWhenStillValid } from "@/features/drive/lib/clipboardPaste"
import { cachedOwnParents } from "@/features/drive/lib/ownAncestry"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { driveListingQueryKey } from "@/features/drive/queries/drive"
import { queryClient } from "@/queries/client"

// A directory a paste can land in without being on screen: a listing row or tile, or a sidebar tree
// node. `uuid` is null for My Drive's root; `ancestry` is its root-to-directory uuid chain as far as the
// route proves it, the directory itself last.
export interface PasteDirectory {
	variant: DriveVariant
	uuid: string | null
	ancestry: readonly string[]
	name: string
}

// Judged from the cache alone: the directory's listing counts when something has read it, and nothing
// is fetched for the check.
export function directoryPasteTarget(directory: PasteDirectory, online: boolean): DirectoryPasteTarget {
	return {
		variant: directory.variant,
		uuid: directory.uuid,
		ancestry: directory.ancestry,
		readParents: cachedOwnParents,
		listing: queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: directory.variant, uuid: directory.uuid })),
		online,
		parentUuid: directory.uuid ?? currentRootUuid()
	}
}

// Judged again when the recheck settles, against the connection and the cache as they are then — not
// as they were when the menu rendered or the key went down.
export function pasteIntoDirectory(directory: PasteDirectory): void {
	void pasteWhenStillValid(
		entry => canPasteIntoDirectory(entry, directoryPasteTarget(directory, onlineManager.isOnline())),
		() => Promise.resolve({ uuid: directory.uuid, name: directory.name })
	)
}
