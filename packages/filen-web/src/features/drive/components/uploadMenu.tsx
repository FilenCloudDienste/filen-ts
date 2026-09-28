import { type ReactElement, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { UploadIcon } from "lucide-react"
import { isEmptySpaceTarget } from "@/features/drive/lib/clickAway.logic"
import { type PreviewSource } from "@/features/preview/lib/previewSource"
import { useUploadMenuActions } from "@/features/drive/hooks/useUploadMenuActions"
import { DestinationEntries, type DestinationActions } from "@/features/drive/components/destinationMenu"
import { CONTEXT_TREE_MENU_FAMILY, DROPDOWN_TREE_MENU_FAMILY } from "@/features/drive/components/directoryTreeSubmenu"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import type { DrivePasteAction } from "@/features/drive/hooks/useDriveClipboard"

export interface UploadMenuProps {
	// The directory uploaded files land in — the current listing's own uuid (null at My Drive's root).
	parentUuid: string | null
	// True outside a writable location (canWriteVariant — the "drive" variant, or an owned nested
	// sharedOut directory) or while the listing hasn't loaded yet — mirrors NewDirectory's
	// disabled-not-hidden convention so the toolbar's layout stays stable across variant switches.
	disabled?: boolean
	// Opens the full-screen preview overlay on a frozen single-item snapshot — directoryListing.tsx's
	// own useDriveDialogHost().openPreview, threaded in so the newly created text file opens its
	// editor immediately (mobile parity: useDriveUpload.ts's createTextFile does the same once its own
	// upload settles).
	openPreview: (sources: PreviewSource[], index: number) => void
	// True only when `disabled` is caused specifically by the app being offline — surfaced as the
	// trigger's native title, mirroring newDirectory.tsx's own offline/disabled split.
	offline?: boolean
	// True when this listing would actually hide a dot-prefixed name — see NewDirectory's identical prop.
	hiddenNotice?: boolean
	// Pastes the drive clipboard into the directory this menu writes into, or clears it (useDriveClipboard).
	paste?: DrivePasteAction | undefined
}

// The listing's paste: its mod+v pastes into the same directory, and its menus alone offer Clear.
function pasteEntries(paste: DrivePasteAction | undefined) {
	return paste === undefined
		? {}
		: {
				paste: { enabled: paste.enabled, run: paste.run, shortcut: true },
				clear: { enabled: paste.clearable, run: paste.clear }
			}
}

// Toolbar entry point for starting an upload.
export function UploadMenu({ parentUuid, disabled = false, openPreview, offline = false, hiddenNotice = false, paste }: UploadMenuProps) {
	const { t } = useTranslation(["drive", "common"])
	const actions = useUploadMenuActions({ parentUuid, disabled, openPreview, hiddenNotice })

	return (
		<>
			{actions.host}
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="sm"
							// Label sheds below sm so this cluster stops pushing the breadcrumb — and itself — past
							// the card edge; the aria-label is the same key, so the accessible name is unchanged at
							// every width.
							aria-label={t("driveUploadMenuTrigger")}
							disabled={disabled}
							title={offline && disabled ? t("common:offlineActionDisabled") : undefined}
						>
							<UploadIcon />
							<span className="hidden sm:inline">{t("driveUploadMenuTrigger")}</span>
						</Button>
					}
				/>
				{/* Sized to its entries rather than to the (narrow) trigger, so no label wraps. */}
				<DropdownMenuContent
					align="end"
					className="w-max max-w-72 min-w-(--anchor-width)"
				>
					{/* No New directory: the toolbar has its own button beside this one. */}
					<DestinationEntries
						family={DROPDOWN_TREE_MENU_FAMILY}
						actions={actions}
						{...pasteEntries(paste)}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}

export interface UploadContextMenuProps {
	// The listing's own destination host (useDirectoryDestination), pointed at the directory on screen.
	actions: DestinationActions
	disabled?: boolean
	paste?: DrivePasteAction | undefined
	// The listing surface whose empty space opens the menu. Merged onto as the trigger rather than
	// wrapped, so the listbox keeps its own element, ref, focus and scroll container.
	render: ReactElement
	// Fires as the menu opens, however it was opened (pointer, Menu key, long press).
	onOpen: () => void
}

// The toolbar's upload menu, opened by right-clicking a listing's empty space. Disabled exactly where
// the toolbar trigger is, which leaves the browser's own menu in place there. Items and controls inside
// the surface are passed over: a row's own ContextMenu stops the event before it gets here, and
// anything else (an empty state's buttons, a portalled popup bubbling through the React tree) is
// declined via preventBaseUIHandler.
export function UploadContextMenu({ actions, disabled = false, paste, render, onOpen }: UploadContextMenuProps) {
	function isEmptySpace(event: SyntheticEvent<HTMLDivElement>, clientX: number, clientY: number): boolean {
		const bounds = event.currentTarget.getBoundingClientRect()

		return isEmptySpaceTarget(event.target, event.currentTarget, clientX - bounds.left, clientY - bounds.top)
	}

	return (
		<ContextMenu
			disabled={disabled}
			onOpenChange={open => {
				if (open) {
					onOpen()
				}
			}}
		>
			<ContextMenuTrigger
				render={render}
				onContextMenu={event => {
					if (isEmptySpace(event, event.clientX, event.clientY)) {
						return
					}

					event.preventBaseUIHandler()

					// Keeps the event from Base UI's document-level listener, which would still cancel the
					// browser's own menu over a control here. Portalled targets are left alone: their
					// own menu's listener must still see them.
					if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
						event.stopPropagation()
					}
				}}
				onTouchStart={event => {
					const touch = event.touches[0]

					if (!touch || !isEmptySpace(event, touch.clientX, touch.clientY)) {
						event.preventBaseUIHandler()
					}
				}}
			/>
			<ContextMenuContent>
				<DestinationEntries
					family={CONTEXT_TREE_MENU_FAMILY}
					actions={actions}
					{...pasteEntries(paste)}
				/>
			</ContextMenuContent>
		</ContextMenu>
	)
}
