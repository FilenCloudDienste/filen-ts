import { useEffect, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode, type SyntheticEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { UploadIcon } from "lucide-react"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { normalizeTextFileName, runCreateTextFile } from "@/features/drive/lib/createTextFile"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
import { isEmptySpaceTarget } from "@/features/drive/lib/clickAway.logic"
import { driveListingQueryUpdate, useHeicUploadConvertPreferenceQuery } from "@/features/drive/queries/drive"
import { type PreviewSource, drivePreviewSources } from "@/features/preview/lib/previewSource"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger
} from "@/components/ui/context-menu"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { Kbd } from "@/lib/keymap/kbd"
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

interface UploadMenuActions {
	pickFiles: () => void
	pickDirectory: () => void
	newTextFile: () => void
	heicConvert: boolean
	setHeicConvert: (next: boolean) => void
	// The hidden pickers and the text-file name dialog. Mounted beside the menu, never inside its popup:
	// the popup unmounts on close, before a picker's change or the dialog's submit arrives.
	host: ReactNode
}

// Each file/directory picker is a hidden <input type="file">, triggered via ref+click (mirrors
// masterKeysFileField.tsx) — its value is reset after every pick so choosing the exact same
// file(s)/directory again still fires change. "New text file" instead opens a name dialog (reusing
// the shared InputDialog primitive, same validation convention as newDirectory.tsx).
function useUploadMenuActions({
	parentUuid,
	disabled,
	openPreview,
	hiddenNotice
}: Required<Pick<UploadMenuProps, "parentUuid" | "disabled" | "openPreview" | "hiddenNotice">>): UploadMenuActions {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)
	const directoryInputRef = useRef<HTMLInputElement>(null)
	const [textFileDialogOpen, setTextFileDialogOpen] = useState(false)
	const [textFilePending, setTextFilePending] = useState(false)
	const heicConvertQuery = useHeicUploadConvertPreferenceQuery()

	// `webkitdirectory` has no slot in React's InputHTMLAttributes (it IS a real HTMLInputElement
	// property — lib.dom.d.ts declares it — just not one React's JSX typings expose), so it's set
	// imperatively on the real DOM node instead of a typed-spread hack.
	useEffect(() => {
		const input = directoryInputRef.current

		if (input) {
			input.webkitdirectory = true
		}
	}, [])

	function handleFilesChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startUploads(files, parentUuid)
		e.target.value = ""
	}

	function handleDirectoryChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startDirectoryUpload({ kind: "files", files }, parentUuid)
		e.target.value = ""
	}

	async function handleToggleHeicConvert(next: boolean): Promise<void> {
		await setHeicUploadConvertPreference(next)
		await heicConvertQuery.refetch()
	}

	async function handleTextFileSubmit(name: string): Promise<void> {
		setTextFilePending(true)

		// The NORMALIZED name is what actually lands (and what the row will show), so it is also what
		// the hidden-name check below has to judge.
		const normalized = normalizeTextFileName(name.trim())
		const outcome = await runCreateTextFile(
			{
				uploadFileBytes: (parent, data, fileName, mime) => sdkApi.uploadFileBytes(parent, data, fileName, mime),
				patchListing: driveListingQueryUpdate
			},
			parentUuid,
			normalized
		)

		setTextFilePending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash with a directory) so the user can fix the
			// name and retry — mirrors newDirectory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setTextFileDialogOpen(false)
		notifyIfNameIsHidden(normalized, "created", hiddenNotice)
		// Opens the editor immediately (mobile parity — useDriveUpload.ts's createTextFile does the
		// same). A single-item frozen snapshot, same as a lone previewable item's own open path
		// (directoryListing.tsx's handleOpen).
		openPreview(drivePreviewSources([outcome.item]), 0)
	}

	return {
		pickFiles: () => {
			inputRef.current?.click()
		},
		pickDirectory: () => {
			directoryInputRef.current?.click()
		},
		newTextFile: () => {
			setTextFileDialogOpen(true)
		},
		// Off by default (mobile parity: DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED), applied by startUploads to
		// every HEIC/HEIF file in a picked/dropped batch. Read as a query rather than local state so a
		// change is reflected immediately in every other mounted upload menu too (same convention as
		// every other kv-backed preference in this app).
		heicConvert: heicConvertQuery.data ?? false,
		setHeicConvert: next => {
			void handleToggleHeicConvert(next)
		},
		host: (
			<>
				<input
					ref={inputRef}
					type="file"
					multiple
					disabled={disabled}
					className="hidden"
					onChange={handleFilesChosen}
				/>
				<input
					// A testid, deliberately NOT an id: this menu mounts more than once per listing (toolbar,
					// the empty state's own add affordance, the background context menu), and a fixed id would
					// be an invalid duplicate. Only tests address this input directly — the menu items click it
					// through the ref.
					data-testid="drive-upload-directory-input"
					ref={directoryInputRef}
					type="file"
					disabled={disabled}
					className="hidden"
					onChange={handleDirectoryChosen}
				/>
				<InputDialog
					open={textFileDialogOpen}
					pending={textFilePending}
					title={t("driveNewTextFileTitle")}
					body={t("driveNewTextFileBody")}
					label={t("driveNewTextFileLabel")}
					placeholder={t("driveNewTextFilePlaceholder")}
					submitLabel={t("driveNewTextFileSubmit")}
					validate={name => name.trim().length > 0}
					onOpenChange={setTextFileDialogOpen}
					onSubmit={value => {
						void handleTextFileSubmit(value)
					}}
				/>
			</>
		)
	}
}

// Base UI's DropdownMenu and ContextMenu are separate Root families whose rows are not
// interchangeable across triggers — see itemMenu.tsx's identical split.
interface UploadMenuFamily {
	Item: typeof DropdownMenuItem
	Separator: typeof DropdownMenuSeparator
	CheckboxItem: typeof DropdownMenuCheckboxItem
}

const DROPDOWN_FAMILY: UploadMenuFamily = {
	Item: DropdownMenuItem,
	Separator: DropdownMenuSeparator,
	CheckboxItem: DropdownMenuCheckboxItem
}

const CONTEXT_FAMILY: UploadMenuFamily = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	CheckboxItem: ContextMenuCheckboxItem
}

// The one entry list both surfaces render. "New text file" rides the same trigger/gating as the two
// upload pickers rather than a separate button, since it's the same "put a new file into this
// directory" family (mobile nests it under its own create menu for the identical reason).
function UploadMenuEntries({
	actions,
	family,
	paste
}: {
	actions: UploadMenuActions
	family: UploadMenuFamily
	paste: DrivePasteAction | undefined
}) {
	const { t } = useTranslation("drive")
	const { Item, Separator, CheckboxItem } = family

	return (
		<>
			<Item onClick={actions.pickFiles}>{t("driveUploadFiles")}</Item>
			<Item onClick={actions.pickDirectory}>{t("driveUploadDirectory")}</Item>
			<Item onClick={actions.newTextFile}>{t("driveNewTextFile")}</Item>
			<Separator />
			{paste === undefined ? null : (
				<>
					<Item
						disabled={!paste.enabled}
						onClick={paste.run}
					>
						{t("driveClipboardPaste")}
						<span className="ml-auto pl-4">
							<Kbd action="drive.paste" />
						</span>
					</Item>
					<Item
						disabled={!paste.clearable}
						onClick={paste.clear}
					>
						{t("driveClipboardClear")}
					</Item>
					<Separator />
				</>
			)}
			<CheckboxItem
				checked={actions.heicConvert}
				onCheckedChange={actions.setHeicConvert}
			>
				{t("driveConvertHeicToJpg")}
			</CheckboxItem>
		</>
	)
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
					<UploadMenuEntries
						actions={actions}
						family={DROPDOWN_FAMILY}
						paste={paste}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	)
}

export interface UploadContextMenuProps extends Omit<UploadMenuProps, "offline"> {
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
export function UploadContextMenu({
	parentUuid,
	disabled = false,
	openPreview,
	hiddenNotice = false,
	paste,
	render,
	onOpen
}: UploadContextMenuProps) {
	const actions = useUploadMenuActions({ parentUuid, disabled, openPreview, hiddenNotice })

	function isEmptySpace(event: SyntheticEvent<HTMLDivElement>, clientX: number, clientY: number): boolean {
		const bounds = event.currentTarget.getBoundingClientRect()

		return isEmptySpaceTarget(event.target, event.currentTarget, clientX - bounds.left, clientY - bounds.top)
	}

	return (
		<>
			{actions.host}
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
					<UploadMenuEntries
						actions={actions}
						family={CONTEXT_FAMILY}
						paste={paste}
					/>
				</ContextMenuContent>
			</ContextMenu>
		</>
	)
}
