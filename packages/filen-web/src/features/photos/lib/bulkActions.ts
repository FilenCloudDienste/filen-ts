import { ACTION_DEFS } from "@/features/drive/lib/actionDefs"
import type { DriveSelectionFlags } from "@/features/drive/lib/selectionFlags"
import type { BulkActionDescriptor } from "@/features/drive/components/bulkActionBar.logic"

export type { BulkActionDescriptor }

// The photos bulk-action bar's fixed descriptor set (favorite/unfavorite, download, share, trash) —
// reuses the SAME ACTION_DEFS facts (and BulkActionDescriptor shape) driveBulkActions builds from,
// but with no variant/undecryptable dispatch of its own: a photos selection is always owned,
// decryptable files (isPhotoItem's own precondition), so there is no trash/sharedIn/links/
// undecryptable branch to gate against. Move is deliberately dropped — mobile hides Move from its own
// photos context (menuActions.ts), matching the same "no navigation context to move from" rationale
// as itemActions.ts's own Move exclusion. Unshare/restoreSelected/delete/disableLink never apply
// either: a photos item is never a shared-root arm, never trashed (trash removes it from the
// listing), and links has no photos analogue.
export function photosBulkActions(flags: DriveSelectionFlags): BulkActionDescriptor[] {
	return [
		{ id: "favorite", ...(flags.includesFavorited ? ACTION_DEFS.unfavorite : ACTION_DEFS.favorite), run: "direct" },
		{ id: "download", ...ACTION_DEFS.download, run: "direct" },
		{ id: "share", ...ACTION_DEFS.share, run: "dialog", dialogKind: "share" },
		{ id: "trash", ...ACTION_DEFS.trash, run: "dialog", dialogKind: "trash" }
	]
}
