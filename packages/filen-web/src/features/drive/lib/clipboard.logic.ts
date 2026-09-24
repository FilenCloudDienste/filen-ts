import { type DriveItem } from "@/features/drive/lib/item"
import { canMoveVariant, canWriteVariant, type DriveVariant } from "@/features/drive/lib/preferences"
import { isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"
import { ancestryHits, isMoveNoOp, ownDirectoryUuids, type ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"
import { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboardStore"

// Copy is offered wherever the item menu offers Copy: every listing but the trash, decryptable items only.
export function canCopyToClipboard(items: readonly DriveItem[], variant: DriveVariant): boolean {
	return items.length > 0 && variant !== "trash" && items.every(item => !item.data.undecryptable)
}

// Cut is offered wherever the item menu offers Move.
export function canCutToClipboard(items: readonly DriveItem[], variant: DriveVariant): boolean {
	return canCopyToClipboard(items, variant) && canMoveVariant(variant) && !isReadOnlySharedVariant(variant)
}

export interface PasteTarget {
	variant: DriveVariant
	// The directory on screen, null at a root.
	uuid: string | null
	// Its root-to-directory uuid chain, the directory itself last. From the route, so it proves which
	// directories hold it but not which don't: one opened from search, Favorites or a link starts afresh.
	ancestry: readonly string[]
	// Reads its real parents, asked only while a directory is on the clipboard.
	readParents: () => ParentLookup
	// Its listing; undefined until it has loaded.
	listing: readonly DriveItem[] | undefined
	online: boolean
}

// Every row's menu asks on each render, so an entry's directories are derived once.
const entryDirectories = new WeakMap<DriveClipboardEntry, ReadonlySet<string>>()

function directoriesOf(entry: DriveClipboardEntry): ReadonlySet<string> {
	let directories = entryDirectories.get(entry)

	if (directories === undefined) {
		directories = ownDirectoryUuids(entry.items)
		entryDirectories.set(entry, directories)
	}

	return directories
}

// A copied or cut directory can't land in itself or below it. Beyond what the route proves, the chain
// is walked, and one that can't be resolved is refused.
function isIntoOwnSubtree(entry: DriveClipboardEntry, target: PasteTarget): boolean {
	const directories = directoriesOf(entry)

	if (directories.size === 0 || target.uuid === null) {
		return false
	}

	return target.ancestry.some(uuid => directories.has(uuid)) || ancestryHits(target.uuid, directories, target.readParents()) !== false
}

// A paste lands in the directory on screen, which must be writable. A copied directory can't land in
// itself or below it; a cut is a move within My Drive and, like the move picker, not onto its own
// parent.
export function canPaste(entry: DriveClipboardEntry | null, target: PasteTarget): boolean {
	if (entry === null || entry.items.length === 0 || !target.online || target.listing === undefined) {
		return false
	}

	if (!canWriteVariant(target.variant, target.uuid) || isIntoOwnSubtree(entry, target)) {
		return false
	}

	return entry.mode === "copy" || (target.variant === "drive" && !isMoveNoOp(entry.items, target.listing))
}

export interface ClipboardShortcutContext {
	target: EventTarget | null
	// A dialog or menu is open over the listing.
	overlayOpen: boolean
	// Page text is selected; mod+c/mod+x then copy it, as the browser would.
	textSelected: boolean
}

function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	)
}

// Whether mod+c/x/v belongs to the drive clipboard rather than to text editing. react-hotkeys-hook
// already skips form fields and contentEditable; this repeats that on purpose, since stealing a text
// copy or paste from a field loses the user's text.
export function shouldHandleClipboardShortcut(context: ClipboardShortcutContext): boolean {
	return !isEditableTarget(context.target) && !context.overlayOpen && !context.textSelected
}
