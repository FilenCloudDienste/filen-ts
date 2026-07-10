import { type DriveVariant } from "@/features/drive/lib/preferences"
import { type DriveItem } from "@/features/drive/lib/item"
import { isMoveDestinationForbidden } from "@/features/drive/components/moveTargetDialog.logic"

// Pure drag-to-move logic — framework-free so the unit tests exercise it directly (self/descendant/
// same-parent target guards, drag-payload assembly). The browser-facing side (module payload ref,
// dataTransfer marker, drag image, the move op itself) lives in dnd.ts.

// Drag-to-move is a drive-only surface today: its drop targets (directory rows, the sidebar tree, the
// breadcrumb) are all rooted in the owned "drive" hierarchy. recents/favorites/trash/shared have no
// navigable owned tree to drop into, so their rows are never drag sources. Deliberately narrower than
// canMoveVariant (which also allows the move DIALOG from favorites/recents) — the parenthetical gate
// for THIS feature.
export function canDragVariant(variant: DriveVariant): boolean {
	return variant === "drive"
}

// Dragging a SELECTED item drags the whole current selection; dragging an UNSELECTED item drags just
// it (the caller also selects it, matching desktop convention). Object identity is preserved — the
// returned items are the live DriveItem references, not copies.
export function assembleDragPayload(
	item: DriveItem,
	selectedUuids: ReadonlySet<string>,
	selectedItems: readonly DriveItem[]
): readonly DriveItem[] {
	return selectedUuids.has(item.data.uuid) ? selectedItems : [item]
}

// A move would land every payload item exactly where it already sits — the target IS their common
// parent. Root-normalized on both sides: a root-level item's `parent` is the account root uuid, and
// the root drop target's uuid is null, so both collapse to the same canonical string.
export function isSameParentTarget(targetUuid: string | null, payload: readonly DriveItem[], rootUuid: string): boolean {
	if (payload.length === 0) {
		return false
	}

	const canonicalTarget = targetUuid ?? rootUuid

	return payload.every(item => item.data.parent === canonicalTarget)
}

export interface MoveTargetParams {
	// The drop target's own uuid — null for the drive root.
	targetUuid: string | null
	// The target's root-to-target uuid chain, inclusive of the target itself; empty for the root.
	targetAncestry: readonly string[]
	payload: readonly DriveItem[]
	rootUuid: string
}

// The single client-side validity gate every drop target shares. The SDK/server remains the final
// validator — a rejection there surfaces as the standard error toast — so this only rules out the
// cheap, locally-knowable illegal drops: an empty payload, moving a directory into itself or a
// descendant (self/descendant, via the target's known ancestry), and a no-op onto the current parent.
export function isValidMoveTarget({ targetUuid, targetAncestry, payload, rootUuid }: MoveTargetParams): boolean {
	if (payload.length === 0) {
		return false
	}

	if (isMoveDestinationForbidden(targetAncestry, payload)) {
		return false
	}

	if (isSameParentTarget(targetUuid, payload, rootUuid)) {
		return false
	}

	return true
}
