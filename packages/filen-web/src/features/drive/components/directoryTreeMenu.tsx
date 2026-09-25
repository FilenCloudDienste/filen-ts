import { useRef, useState, type ReactElement, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { type HotkeyCallback } from "react-hotkeys-hook"
import { onlineManager } from "@tanstack/react-query"
import { ClipboardPasteIcon, FilePlusIcon, FolderOpenIcon, FolderPlusIcon, FolderUpIcon, UploadIcon } from "lucide-react"
import { driveItemName } from "@filen/shared"
import { type DriveItem } from "@/features/drive/lib/item"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { DEFAULT_HIDE_HIDDEN_ITEMS } from "@/features/drive/lib/preferences"
import { hiddenFilterAppliesTo } from "@/features/drive/lib/hiddenItems"
import { cachedOwnParents } from "@/features/drive/lib/ownAncestry"
import {
	canCopyToClipboard,
	canCutToClipboard,
	canPasteIntoDirectory,
	shouldHandleClipboardShortcut,
	type DirectoryPasteTarget
} from "@/features/drive/lib/clipboard.logic"
import { clipboardShortcutContext, copyToClipboard, cutToClipboard } from "@/features/drive/lib/clipboard"
import { pasteWhenStillValid } from "@/features/drive/lib/clipboardPaste"
import { cachedTreeDirectory, driveListingQueryKey, useHideHiddenItemsPreferenceQuery } from "@/features/drive/queries/drive"
import { useDriveClipboardStore } from "@/features/drive/store/useDriveClipboardStore"
import { useDriveDialogHost } from "@/features/drive/hooks/useDriveDialogHost"
import { DriveContextMenuContent } from "@/features/drive/components/itemMenu"
import { NewDirectoryDialog } from "@/features/drive/components/newDirectory"
import { useUploadMenuActions, type UploadMenuActions } from "@/features/drive/hooks/useUploadMenuActions"
import { queryClient } from "@/queries/client"
import { useIsOnline } from "@/lib/useIsOnline"
import { useAction } from "@/lib/keymap/useAction"
import { Kbd } from "@/lib/keymap/kbd"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"

// Every tree row (the Cloud Drive root included) carries its root-to-node uuid chain here, "/"-joined —
// empty for the root. The one menu and the clipboard shortcuts below find their node through it.
export const TREE_PATH_ATTRIBUTE = "data-tree-path"

// Set on the row whose menu is open, so it keeps a highlight while the menu covers the pointer.
const MENU_OPEN_ATTRIBUTE = "data-menu-open"

type TreeDirectory = Extract<DriveItem, { type: "directory" }>

interface TreeNodeTarget {
	// Root-to-node uuid chain, the node itself last; empty for the root.
	path: string[]
	// The node's own row; undefined for the root, which is no item.
	item: TreeDirectory | undefined
}

function treeRowOf(target: EventTarget | null, within: Element): HTMLElement | null {
	const row = target instanceof Element ? target.closest<HTMLElement>(`[${TREE_PATH_ATTRIBUTE}]`) : null

	return row !== null && within.contains(row) ? row : null
}

// The node a row stands for, or null for a node whose row its level no longer holds.
function resolveTarget(row: HTMLElement): TreeNodeTarget | null {
	const raw = row.getAttribute(TREE_PATH_ATTRIBUTE) ?? ""
	const path = raw.length === 0 ? [] : raw.split("/")
	const uuid = path.at(-1)

	if (uuid === undefined) {
		return { path, item: undefined }
	}

	const item = cachedTreeDirectory(path.at(-2) ?? null, uuid)

	return item === undefined ? null : { path, item }
}

// A paste into the node judged from the cache alone: its listing counts when a level or the listing has
// read it, and nothing is fetched for the check.
function pasteTarget(path: string[], online: boolean): DirectoryPasteTarget {
	const uuid = path.at(-1) ?? null

	return {
		variant: "drive",
		uuid,
		ancestry: path,
		readParents: cachedOwnParents,
		listing: queryClient.getQueryData<DriveItem[]>(driveListingQueryKey({ variant: "drive", uuid })),
		online,
		parentUuid: uuid ?? currentRootUuid()
	}
}

export interface DirectoryTreeMenuProps {
	// The tree surface (the root row and every node below it). Merged onto as the trigger rather than
	// wrapped, so the list keeps its own element and semantics.
	render: ReactElement
	onNavigate: (path: string[]) => void
}

// The sidebar tree's actions: ONE context menu for the whole tree rather than one per node, opened on
// whichever row was right-clicked (or focused, for the Menu key / Shift+F10, which fire the same
// contextmenu event there). A node's menu is the listing row's own item menu for the same directory,
// headed by what the directory offers as a destination; the root's is that head alone. mod+c/x/v act on
// the focused node the same way. The dialogs these open live here, beside the menu, since the popup
// unmounts on close before they finish.
export function DirectoryTreeMenu({ render, onNavigate }: DirectoryTreeMenuProps) {
	const { t } = useTranslation("drive")
	const isOnline = useIsOnline()
	const hiddenPrefQuery = useHideHiddenItemsPreferenceQuery()
	const hiddenNotice = (hiddenPrefQuery.data ?? DEFAULT_HIDE_HIDDEN_ITEMS) && hiddenFilterAppliesTo("drive")
	// Set as the menu opens; kept after it closes, since an upload picker or the name dialogs it started
	// still write into this node.
	const [target, setTarget] = useState<TreeNodeTarget | null>(null)
	const [newDirectoryOpen, setNewDirectoryOpen] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	// The row a contextmenu or touch landed on, read as the menu opens.
	const pendingRowRef = useRef<HTMLElement | null>(null)
	const openRowRef = useRef<HTMLElement | null>(null)
	const targetUuid = target?.path.at(-1) ?? null
	const writable = isOnline && target?.item?.data.undecryptable !== true
	const dialogHost = useDriveDialogHost({ variant: "drive", selectedItems: [], hiddenNoticeApplies: hiddenNotice })
	const upload = useUploadMenuActions({
		parentUuid: targetUuid,
		disabled: !writable,
		openPreview: dialogHost.openPreview,
		hiddenNotice,
		testIdPrefix: "drive-tree-upload"
	})

	function applyTarget(row: HTMLElement, next: TreeNodeTarget): void {
		if (openRowRef.current !== row) {
			openRowRef.current?.removeAttribute(MENU_OPEN_ATTRIBUTE)
			row.setAttribute(MENU_OPEN_ATTRIBUTE, "")
			openRowRef.current = row
		}

		setTarget(next)
	}

	// A long press opens the menu without a contextmenu event, so its row is applied here.
	function handleOpenChange(open: boolean): void {
		setMenuOpen(open)

		if (!open) {
			openRowRef.current?.removeAttribute(MENU_OPEN_ATTRIBUTE)
			openRowRef.current = null

			return
		}

		const row = pendingRowRef.current
		const next = row === null || row === openRowRef.current ? null : resolveTarget(row)

		if (row !== null && next !== null) {
			applyTarget(row, next)
		}
	}

	// The row an event landed on, remembered for the menu about to open. Anywhere else (the loading and
	// error lines) keeps the browser's own menu.
	function claimRow(
		event: SyntheticEvent<HTMLElement> & { preventBaseUIHandler: () => void }
	): { row: HTMLElement; next: TreeNodeTarget } | null {
		const row = treeRowOf(event.target, event.currentTarget)
		const next = row === null ? null : resolveTarget(row)

		pendingRowRef.current = next === null ? null : row

		if (row === null || next === null) {
			event.preventBaseUIHandler()

			return null
		}

		return { row, next }
	}

	// The focused node owns the shortcut: the listing's document-wide handler would otherwise act on the
	// listing's own selection too. Stands down (without preventDefault) when it has nothing to do, so the
	// browser's own copy/paste still runs.
	function handleShortcut(event: KeyboardEvent, kind: "copy" | "cut" | "paste"): void {
		if (!(event.currentTarget instanceof Element)) {
			return
		}

		const row = treeRowOf(event.target, event.currentTarget)
		const node = row === null ? null : resolveTarget(row)

		if (node === null) {
			return
		}

		event.stopPropagation()

		if (!shouldHandleClipboardShortcut(clipboardShortcutContext(event, kind !== "paste"))) {
			return
		}

		if (kind === "paste") {
			const destination = pasteTarget(node.path, isOnline)

			if (node.item?.data.undecryptable !== true && canPasteIntoDirectory(useDriveClipboardStore.getState().entry, destination)) {
				event.preventDefault()
				runPaste(node)
			}

			return
		}

		const items = node.item === undefined ? [] : [node.item]

		if (kind === "copy" && canCopyToClipboard(items, "drive")) {
			event.preventDefault()
			copyToClipboard(items)
		} else if (kind === "cut" && canCutToClipboard(items, "drive")) {
			event.preventDefault()
			cutToClipboard(items)
		}
	}

	// Judged again when the recheck settles, against the connection and the cache as they are then — not
	// as they were when the menu rendered or the key went down.
	function runPaste(node: TreeNodeTarget): void {
		const name = node.item === undefined ? t("driveMyDrive") : driveItemName(node.item)

		void pasteWhenStillValid(
			entry => canPasteIntoDirectory(entry, pasteTarget(node.path, onlineManager.isOnline())),
			() => Promise.resolve({ uuid: node.path.at(-1) ?? null, name })
		)
	}

	const onCopy: HotkeyCallback = event => {
		handleShortcut(event, "copy")
	}
	const onCut: HotkeyCallback = event => {
		handleShortcut(event, "cut")
	}
	const onPaste: HotkeyCallback = event => {
		handleShortcut(event, "paste")
	}
	const copyRef = useAction("drive.copy", onCopy, undefined, [onCopy])
	const cutRef = useAction("drive.cut", onCut, undefined, [onCut])
	const pasteRef = useAction("drive.paste", onPaste, undefined, [onPaste])

	function renderEntries(node: TreeNodeTarget) {
		return (
			<TreeTargetEntries
				node={node}
				writable={writable}
				isOnline={isOnline}
				upload={upload}
				onOpen={() => {
					onNavigate(node.path)
				}}
				onNewDirectory={() => {
					setNewDirectoryOpen(true)
				}}
				onPaste={() => {
					runPaste(node)
				}}
			/>
		)
	}

	return (
		<>
			{/* The pickers exist only while the menu or one of its uploads is in use: the sidebar precedes the
			    listing in the page, and standing file inputs here would be the first a page-wide lookup finds. */}
			{menuOpen || upload.busy ? upload.host : null}
			<NewDirectoryDialog
				open={newDirectoryOpen}
				onOpenChange={setNewDirectoryOpen}
				parentUuid={targetUuid}
				hiddenNotice={hiddenNotice}
			/>
			{dialogHost.renderActiveDialog()}
			<ContextMenu onOpenChange={handleOpenChange}>
				<ContextMenuTrigger
					ref={element => {
						copyRef(element)
						cutRef(element)
						pasteRef(element)
					}}
					render={render}
					onContextMenu={event => {
						const claimed = claimRow(event)

						if (claimed === null) {
							// Keeps the event from Base UI's document-level listener, which would still cancel the
							// browser's own menu here.
							event.stopPropagation()

							return
						}

						// Applied now rather than on open: a right-click on another row while the menu is open
						// retargets it.
						applyTarget(claimed.row, claimed.next)
					}}
					onTouchStart={event => {
						claimRow(event)
					}}
				/>
				{target === null ? null : target.item === undefined ? (
					<ContextMenuContent>{renderEntries(target)}</ContextMenuContent>
				) : (
					<DriveContextMenuContent
						item={target.item}
						variant="drive"
						onItemAction={dialogHost.handleItemAction}
						leading={renderEntries(target)}
					/>
				)}
			</ContextMenu>
		</>
	)
}

interface TreeTargetEntriesProps {
	node: TreeNodeTarget
	// Online, and the node's own name and keys decrypted, so something can be written into it.
	writable: boolean
	isOnline: boolean
	upload: UploadMenuActions
	onOpen: () => void
	onNewDirectory: () => void
	onPaste: () => void
}

// What a directory offers as a destination — the listing's toolbar and empty-space menu, for this node.
// Mounted only while the menu is open, so the clipboard subscription below is too.
function TreeTargetEntries({ node, writable, isOnline, upload, onOpen, onNewDirectory, onPaste }: TreeTargetEntriesProps) {
	const { t } = useTranslation("drive")
	const entry = useDriveClipboardStore(state => state.entry)
	const destination = pasteTarget(node.path, isOnline)

	return (
		<>
			<ContextMenuItem
				disabled={node.item?.data.undecryptable === true}
				onClick={onOpen}
			>
				<FolderOpenIcon aria-hidden="true" />
				{t("driveActionOpen")}
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem
				disabled={!writable}
				onClick={onNewDirectory}
			>
				<FolderPlusIcon aria-hidden="true" />
				{t("driveNewDirectoryTitle")}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!writable}
				onClick={upload.pickFiles}
			>
				<UploadIcon aria-hidden="true" />
				{t("driveUploadFiles")}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!writable}
				onClick={upload.pickDirectory}
			>
				<FolderUpIcon aria-hidden="true" />
				{t("driveUploadDirectory")}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!writable}
				onClick={upload.newTextFile}
			>
				<FilePlusIcon aria-hidden="true" />
				{t("driveNewTextFile")}
			</ContextMenuItem>
			<ContextMenuItem
				disabled={!writable || !canPasteIntoDirectory(entry, destination)}
				onClick={onPaste}
			>
				<ClipboardPasteIcon aria-hidden="true" />
				{t("driveClipboardPaste")}
				<span className="ml-auto pl-4">
					<Kbd action="drive.paste" />
				</span>
			</ContextMenuItem>
		</>
	)
}
