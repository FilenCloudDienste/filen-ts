import { canPasteIntoDirectory } from "@/features/drive/lib/clipboard.logic"
import { directoryPasteTarget, pasteIntoDirectory, type PasteDirectory } from "@/features/drive/lib/directoryPaste"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useIsOnline } from "@/lib/useIsOnline"
import { type DestinationPaste } from "@/features/drive/components/destinationMenu"

// Paste into a directory that need not be on screen. Subscribes to the clipboard, so it belongs in menu
// content, which is mounted only while open.
export function useDirectoryPaste(directory: PasteDirectory, shortcut: boolean): DestinationPaste {
	const isOnline = useIsOnline()
	const entry = useDriveClipboardStore(state => state.entry)

	return {
		enabled: canPasteIntoDirectory(entry, directoryPasteTarget(directory, isOnline)),
		run: () => {
			pasteIntoDirectory(directory)
		},
		shortcut
	}
}
