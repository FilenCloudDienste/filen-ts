import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { onlineManager } from "@tanstack/react-query"
import { type HotkeyCallback } from "react-hotkeys-hook"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { destinationDirectoryName, directoryNameScope } from "@/features/drive/queries/drive"
import { cachedOwnParents } from "@/features/drive/lib/ownAncestry"
import { canCopyToClipboard, canCutToClipboard, canPaste, shouldHandleClipboardShortcut } from "@/features/drive/lib/clipboard.logic"
import { clipboardShortcutContext, copyToClipboard, cutToClipboard } from "@/features/drive/lib/clipboard"
import { pasteWhenStillValid } from "@/features/drive/lib/clipboardPaste"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useAction } from "@/lib/keymap/useAction"

export interface DrivePasteAction {
	enabled: boolean
	run: () => void
	// Something is copied or cut, whether or not it can be pasted here.
	clearable: boolean
	clear: () => void
}

export interface UseDriveClipboardParams {
	variant: DriveVariant
	// The directory on screen and its root-to-directory uuid chain.
	uuid: string | null
	ancestry: readonly string[]
	// Its listing; undefined until it has loaded.
	listing: readonly DriveItem[] | undefined
	selectedItems: readonly DriveItem[]
	isOnline: boolean
	isDialogOpen: boolean
}

// The listing's mod+c/x/v and the Paste and Clear clipboard entries its menus show. Each shortcut
// stands down (without preventDefault) whenever it has nothing to do, so the browser's own copy/paste
// still runs.
export function useDriveClipboard({
	variant,
	uuid,
	ancestry,
	listing,
	selectedItems,
	isOnline,
	isDialogOpen
}: UseDriveClipboardParams): DrivePasteAction {
	const { t } = useTranslation("drive")
	const entry = useDriveClipboardStore(state => state.entry)
	const target = { variant, uuid, ancestry, readParents: cachedOwnParents, listing, online: isOnline }
	const pasteEnabled = canPaste(entry, target)
	// The listing as last rendered, for a paste judged again once its recheck settles.
	const listingRef = useRef(listing)

	useEffect(() => {
		listingRef.current = listing
	})

	async function destinationName(): Promise<string> {
		if (uuid === null) {
			return t("driveMyDrive")
		}

		// No try/catch: a `??` inside one makes the React Compiler skip the whole hook.
		const name = await destinationDirectoryName(directoryNameScope(variant), ancestry).catch(() => null)

		return name ?? ""
	}

	function paste(): void {
		// Against the listing and the connection as they are when the recheck settles, not as this render
		// saw them.
		void pasteWhenStillValid(
			current => canPaste(current, { ...target, listing: listingRef.current, online: onlineManager.isOnline() }),
			async () => ({ uuid, name: await destinationName() })
		)
	}

	function claims(event: KeyboardEvent, textMatters: boolean): boolean {
		return !isDialogOpen && shouldHandleClipboardShortcut(clipboardShortcutContext(event, textMatters))
	}

	const onCopy: HotkeyCallback = event => {
		if (claims(event, true) && canCopyToClipboard(selectedItems, variant)) {
			event.preventDefault()
			copyToClipboard(selectedItems)
		}
	}

	const onCut: HotkeyCallback = event => {
		if (claims(event, true) && canCutToClipboard(selectedItems, variant)) {
			event.preventDefault()
			cutToClipboard(selectedItems)
		}
	}

	const onPaste: HotkeyCallback = event => {
		if (claims(event, false) && pasteEnabled) {
			event.preventDefault()
			paste()
		}
	}

	useAction("drive.copy", onCopy, undefined, [onCopy])
	useAction("drive.cut", onCut, undefined, [onCut])
	useAction("drive.paste", onPaste, undefined, [onPaste])

	return {
		enabled: pasteEnabled,
		run: paste,
		clearable: entry !== null,
		clear: () => {
			useDriveClipboardStore.getState().clear()
		}
	}
}
