import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { onlineManager } from "@tanstack/react-query"
import { type HotkeyCallback } from "react-hotkeys-hook"
import { type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { destinationDirectoryName, directoryNameScope } from "@/features/drive/queries/drive"
import { cachedOwnParents } from "@/features/drive/lib/ownAncestry"
import { canCopyToClipboard, canCutToClipboard, canPaste, shouldHandleClipboardShortcut } from "@/features/drive/lib/clipboard.logic"
import { clipboardShortcutContext, copyToClipboard, cutToClipboard, systemClipboardOutdated } from "@/features/drive/lib/clipboard"
import { pasteWhenStillValid } from "@/features/drive/lib/clipboardPaste"
import {
	clipboardEntries,
	clipboardFiles,
	clipboardNameTime,
	isNativePasteKey,
	namePastedFiles
} from "@/features/drive/lib/clipboardUpload.logic"
import { uploadFileSet } from "@/features/drive/lib/uploadDrop"
import { canWriteVariant } from "@/features/drive/lib/preferences"
import { isAnyOverlayOpen } from "@/lib/keymap/dialogGuard"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useAction } from "@/lib/keymap/useAction"
import { useLatestRef } from "@/lib/useLatestRef"

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
}

// How long a mod+v waits for the paste event the browser fires after it before pasting the drive clipboard on its
// own, for a browser that fires none outside an editable element. The event comes within a few milliseconds.
const PASTE_EVENT_WAIT_MS = 250

// The listing's mod+c/x/v and the Paste and Clear clipboard entries its menus show. Each shortcut
// stands down (without preventDefault) whenever it has nothing to do, so the browser's own copy/paste
// still runs.
//
// A paste event on the page (mod+v, the Edit menu's Paste) that carries files, such as a screenshot or files copied
// in a file manager, uploads them into the directory on screen through the drop path; one without files pastes the
// drive clipboard. A drive copy or cut writes the items' names to the system clipboard, so the latest copy wins. Never in a field, an editor or under a dialog or menu.
export function useDriveClipboard({
	variant,
	uuid,
	ancestry,
	listing,
	selectedItems,
	isOnline
}: UseDriveClipboardParams): DrivePasteAction {
	const { t } = useTranslation("drive")
	const entry = useDriveClipboardStore(state => state.entry)
	const target = { variant, uuid, ancestry, readParents: cachedOwnParents, listing, online: isOnline }
	const pasteEnabled = canPaste(entry, target)
	// The listing as last rendered, for a paste judged again once its recheck settles.
	const listingRef = useLatestRef(listing)
	// The directory on screen takes uploads: the same gate as the listing's dropzone.
	const uploadEnabled = canWriteVariant(variant, uuid) && listing !== undefined && isOnline
	// A mod+v's own paste, until the paste event it fires takes over; and when one last ran without an event.
	const pasteKeyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
	const pastedWithoutEventAtRef = useRef(0)

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
		return shouldHandleClipboardShortcut(clipboardShortcutContext(event, textMatters))
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

	// The browser's own paste keys fire a paste event, which knows whether the system clipboard holds files: the key
	// leaves the decision to it and pastes the drive clipboard itself only when none comes.
	const onPaste: HotkeyCallback = event => {
		if (!claims(event, false) || !pasteEnabled) {
			return
		}

		if (!isNativePasteKey(event)) {
			event.preventDefault()
			paste()

			return
		}

		if (pasteKeyTimerRef.current !== null) {
			clearTimeout(pasteKeyTimerRef.current)
		}

		pasteKeyTimerRef.current = setTimeout(() => {
			pasteKeyTimerRef.current = null
			pastedWithoutEventAtRef.current = Date.now()
			paste()
		}, PASTE_EVENT_WAIT_MS)
	}

	function claimsPasteEvent(event: Event): boolean {
		return (
			!event.defaultPrevented &&
			shouldHandleClipboardShortcut({ target: event.target, overlayOpen: isAnyOverlayOpen(), textSelected: false })
		)
	}

	function onPasteEvent(event: ClipboardEvent): void {
		const keyWaiting = pasteKeyTimerRef.current !== null

		if (pasteKeyTimerRef.current !== null) {
			clearTimeout(pasteKeyTimerRef.current)
			pasteKeyTimerRef.current = null
		}

		if (!claimsPasteEvent(event)) {
			return
		}

		const files = clipboardFiles(event.clipboardData)

		// Files the system clipboard held before a drive copy or cut whose names could not replace them are older than
		// it: the drive clipboard pastes.
		if (files.length > 0 && !(pasteEnabled && systemClipboardOutdated())) {
			if (uploadEnabled) {
				const now = new Date()
				const time = clipboardNameTime(now)

				event.preventDefault()
				uploadFileSet(
					namePastedFiles(
						files,
						{ image: t("driveClipboardPastedImageName", { time }), file: t("driveClipboardPastedFileName", { time }) },
						now.getTime()
					),
					clipboardEntries(event.clipboardData),
					uuid
				)
			}

			return
		}

		// A late event for a key whose wait already pasted the drive clipboard pastes nothing more.
		if (pasteEnabled && (keyWaiting || Date.now() - pastedWithoutEventAtRef.current > PASTE_EVENT_WAIT_MS * 4)) {
			event.preventDefault()
			paste()
		}
	}

	// Safari enables Paste outside an editable element, and fires its paste event, only when beforepaste is cancelled.
	function onBeforePasteEvent(event: Event): void {
		if ((uploadEnabled || pasteEnabled) && claimsPasteEvent(event)) {
			event.preventDefault()
		}
	}

	const pasteEventRef = useLatestRef(onPasteEvent)
	const beforePasteEventRef = useLatestRef(onBeforePasteEvent)

	useEffect(() => {
		function handlePaste(event: ClipboardEvent): void {
			pasteEventRef.current(event)
		}

		function handleBeforePaste(event: Event): void {
			beforePasteEventRef.current(event)
		}

		document.addEventListener("paste", handlePaste)
		document.addEventListener("beforepaste", handleBeforePaste)

		return () => {
			document.removeEventListener("paste", handlePaste)
			document.removeEventListener("beforepaste", handleBeforePaste)

			if (pasteKeyTimerRef.current !== null) {
				clearTimeout(pasteKeyTimerRef.current)
				pasteKeyTimerRef.current = null
			}
		}
	}, [pasteEventRef, beforePasteEventRef])

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
