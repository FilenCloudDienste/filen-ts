import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type DriveItem } from "@/features/drive/lib/item"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { performMove } from "@/features/drive/lib/dnd"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { type ClipboardShortcutContext } from "@/features/drive/lib/clipboard.logic"
import { isAnyDialogOpen, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"

export function copyToClipboard(items: readonly DriveItem[]): void {
	useDriveClipboardStore.getState().set({ mode: "copy", items: items.slice() })
	toast.success(i18n.t("drive:driveClipboardCopiedToast", { count: items.length }))
}

export function cutToClipboard(items: readonly DriveItem[]): void {
	useDriveClipboardStore.getState().set({ mode: "cut", items: items.slice() })
	toast.success(i18n.t("drive:driveClipboardCutToast", { count: items.length }))
}

// A copy's clipboard entry stays for further pastes; a cut's is used up by the paste, keeping only
// what failed to move.
export async function pasteClipboard(destination: CopyDestination): Promise<void> {
	const store = useDriveClipboardStore.getState()
	const entry = store.entry

	if (entry === null) {
		return
	}

	if (entry.mode === "copy") {
		startCopyWithCard(entry.items, destination)

		return
	}

	store.clear()

	const outcome = await performMove(entry.items, destination.uuid)

	useDriveClipboardStore.getState().restoreCut(outcome.failed.map(failure => failure.item))
}

// What shouldHandleClipboardShortcut needs to know about a keydown, read off the page. Selected text
// only matters to copy and cut: pasting over it has no text meaning outside a field.
export function clipboardShortcutContext(event: KeyboardEvent, textMatters: boolean): ClipboardShortcutContext {
	const selection = window.getSelection()

	return {
		target: event.target,
		overlayOpen: isAnyDialogOpen() || isAnyMenuOpen(),
		textSelected: textMatters && selection !== null && !selection.isCollapsed
	}
}
