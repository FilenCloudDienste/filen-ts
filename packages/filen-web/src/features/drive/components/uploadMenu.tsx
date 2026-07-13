import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { UploadIcon } from "lucide-react"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { normalizeTextFileName, runCreateTextFile } from "@/features/drive/lib/createTextFile"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
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
import { InputDialog } from "@/components/dialogs/inputDialog"

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
}

// Toolbar entry point for starting an upload. A DropdownMenu (not a bare button) holds "Upload
// files", "Upload directory" and "New text file" side by side — the create-empty-file flow rides the
// same trigger/gating as the two upload pickers rather than a fourth toolbar button, since it's the
// same "put a new file into this directory" family (mobile nests it under its own create menu for the
// identical reason).
//
// Each file/directory picker is a hidden <input type="file">, triggered via ref+click (mirrors
// masterKeysFileField.tsx) — its value is reset after every pick so choosing the exact same
// file(s)/directory again still fires change. "New text file" instead opens a name dialog (reusing
// the shared InputDialog primitive, same validation convention as newDirectory.tsx).
export function UploadMenu({ parentUuid, disabled = false, openPreview, offline = false }: UploadMenuProps) {
	const { t } = useTranslation(["drive", "common"])
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

		const outcome = await runCreateTextFile(
			{
				uploadFileBytes: (parent, data, fileName, mime) => sdkApi.uploadFileBytes(parent, data, fileName, mime),
				patchListing: driveListingQueryUpdate
			},
			parentUuid,
			normalizeTextFileName(name.trim())
		)

		setTextFilePending(false)

		if (outcome.status === "error") {
			// Dialog stays open on error (e.g. a name clash with a directory) so the user can fix the
			// name and retry — mirrors newDirectory.tsx's identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setTextFileDialogOpen(false)
		// Opens the editor immediately (mobile parity — useDriveUpload.ts's createTextFile does the
		// same). A single-item frozen snapshot, same as a lone previewable item's own open path
		// (directoryListing.tsx's handleOpen).
		openPreview(drivePreviewSources([outcome.item]), 0)
	}

	return (
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
				id="drive-upload-directory-input"
				ref={directoryInputRef}
				type="file"
				disabled={disabled}
				className="hidden"
				onChange={handleDirectoryChosen}
			/>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							size="sm"
							disabled={disabled}
							title={offline && disabled ? t("common:offlineActionDisabled") : undefined}
						>
							<UploadIcon />
							{t("driveUploadMenuTrigger")}
						</Button>
					}
				/>
				<DropdownMenuContent>
					<DropdownMenuItem
						onClick={() => {
							inputRef.current?.click()
						}}
					>
						{t("driveUploadFiles")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							directoryInputRef.current?.click()
						}}
					>
						{t("driveUploadDirectory")}
					</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => {
							setTextFileDialogOpen(true)
						}}
					>
						{t("driveNewTextFile")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					{/* Off by default (mobile parity: DEFAULT_CONVERT_HEIC_TO_JPG_ENABLED), applied by
					startUploads to every HEIC/HEIF file in a picked/dropped batch. Read as a query rather than
					local state so a change here is reflected immediately in a concurrently-open second upload
					menu instance too (same convention as every other kv-backed preference in this app). */}
					<DropdownMenuCheckboxItem
						checked={heicConvertQuery.data ?? false}
						onCheckedChange={checked => {
							void handleToggleHeicConvert(checked)
						}}
					>
						{t("driveConvertHeicToJpg")}
					</DropdownMenuCheckboxItem>
				</DropdownMenuContent>
			</DropdownMenu>
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
