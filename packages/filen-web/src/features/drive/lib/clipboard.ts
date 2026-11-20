import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { type DriveItem } from "@/features/drive/lib/item"
import { type CopyDestination } from "@/features/drive/lib/copy.logic"
import { performMove } from "@/features/drive/lib/dnd"
import { confirmDotFilenOperation, includesRootDotFilen } from "@/features/drive/lib/dotFilenGuard"
import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { useDriveClipboardStore, type DriveClipboardMode } from "@/features/drive/store/useDriveClipboardStore"
import { asListed } from "@/features/drive/lib/clipboardRecheck"
import { type ClipboardShortcutContext } from "@/features/drive/lib/clipboard.logic"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"

// Each copy or cut, and the last one whose names reached the system clipboard.
let heldCount = 0
let writtenCount = 0

// The system clipboard takes the items' names, inside the click or key that held them, so the files or screenshot it
// held before no longer reach a later paste event and the drive clipboard pastes; a copy made elsewhere after it
// replaces the names and wins in turn. Nothing is said when the write is refused: systemClipboardOutdated tells.
function writeNames(items: readonly DriveItem[], count: number): void {
	const names = items.flatMap(item => {
		const name = item.data.decryptedMeta?.name

		return name === undefined ? [] : [name]
	})

	try {
		navigator.clipboard
			.writeText(names.join("\n"))
			.then(() => {
				if (count === heldCount) {
					writtenCount = count
				}
			})
			.catch(() => undefined)
	} catch {
		// No clipboard API (an insecure context): the system clipboard stays as it was.
	}
}

function hold(mode: DriveClipboardMode, items: readonly DriveItem[]): void {
	const listed = asListed(items)

	heldCount++
	useDriveClipboardStore.getState().set({ mode, items: listed.items }, listed.current)
	writeNames(items, heldCount)
}

// Whether the system clipboard may still hold what it held before the drive clipboard's entry was made, its write
// refused or not yet done: a paste event's files are then older than the entry, which pastes instead.
export function systemClipboardOutdated(): boolean {
	return useDriveClipboardStore.getState().entry !== null && writtenCount !== heldCount
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

	// Asked before the cut is taken, so a cancel leaves it on the clipboard. Anything else takes it at once.
	if (includesRootDotFilen(entry.items) && !(await confirmDotFilenOperation("move", entry.items))) {
		return
	}

	const paste = useDriveClipboardStore.getState().takeCut()

	if (paste === null) {
		return
	}

	// The cut confirmed above, unless another took its place meanwhile.
	const outcome = await performMove(paste.items, destination, paste.items === entry.items)

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
		overlayOpen: isAnyOverlayOpen(),
		textSelected: textMatters && selection !== null && !selection.isCollapsed
	}
}
