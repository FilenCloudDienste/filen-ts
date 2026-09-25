import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type DriveItem } from "@/features/drive/lib/item"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { performMove } from "@/features/drive/lib/dnd"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { useDriveClipboardStore, type DriveClipboardMode } from "@/features/drive/store/useDriveClipboardStore"
import { asListed } from "@/features/drive/lib/clipboardRecheck"
import { type ClipboardShortcutContext } from "@/features/drive/lib/clipboard.logic"
import { isAnyDialogOpen, isAnyMenuOpen } from "@/lib/keymap/dialogGuard"

function hold(mode: DriveClipboardMode, items: readonly DriveItem[]): void {
	const listed = asListed(items)

	useDriveClipboardStore.getState().set({ mode, items: listed.items }, listed.current)
}

export function copyToClipboard(items: readonly DriveItem[]): void {
	hold("copy", items)
	toast.success(i18n.t("drive:driveClipboardCopiedToast", { count: items.length }))
}

export function cutToClipboard(items: readonly DriveItem[]): void {
	hold("cut", items)
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

	const paste = store.takeCut()

	if (paste === null) {
		return
	}

	const outcome = await performMove(paste.items, destination.uuid)

	useDriveClipboardStore.getState().restoreCut(
		paste,
		outcome.failed.map(failure => failure.item)
	)
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
