import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { pasteClipboard } from "@/features/drive/lib/clipboard"
import { recheckClipboard } from "@/features/drive/lib/clipboardRecheck"
import { useDriveClipboardStore, type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboardStore"

// A paste asked again on use, of the items as they now are: the tree may have changed since the menu or
// shortcut judged it, with nothing re-rendering the surface that did.
export async function pasteWhenStillValid(
	canPasteEntry: (entry: DriveClipboardEntry | null) => boolean,
	destination: () => Promise<CopyDestination>
): Promise<void> {
	const [resolved, current] = await Promise.all([destination(), recheckClipboard()])

	if (current && canPasteEntry(useDriveClipboardStore.getState().entry)) {
		await pasteClipboard(resolved)
	}
}
