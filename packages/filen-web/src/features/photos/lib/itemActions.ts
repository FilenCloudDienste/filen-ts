import {
	RENAME,
	VERSIONS,
	INFO,
	SHARE,
	PUBLIC_LINK,
	COPY_LINK,
	TRASH,
	favoriteDescriptor,
	downloadDescriptor,
	type ItemActionDescriptor
} from "@/features/drive/components/itemMenu.logic"
import type { DriveItem } from "@/features/drive/lib/item"

export type { ItemActionDescriptor }

// Per-item menu for a photos tile — reuses the SAME descriptor objects a read-write drive listing's
// own itemMenu.logic.ts builds from (one ACTION_DEFS-backed source per action), gated down to a fixed
// list rather than driveItemActions' own variant/type dispatch: a photos item is ALWAYS an owned file
// with decrypted metadata (isPhotoItem's own precondition — see predicate.ts), so there is no
// trash/shared/undecryptable/directory branch to reduce against here.
//
// Move and Color are the two navigation-dependent entries dropped versus a read-write drive listing:
// Color never applies (a photos item is always a file, never a directory), and Move is deliberately
// excluded to match mobile, which hides Move from its own photos context (menuActions.ts) — photos is
// a flat cross-tree projection with no directory-navigation context a move destination picker would
// make sense restarting from.
export function photosItemActions(item: DriveItem): ItemActionDescriptor[] {
	return [RENAME, favoriteDescriptor(item), VERSIONS, INFO, downloadDescriptor(), SHARE, PUBLIC_LINK, COPY_LINK, TRASH]
}
