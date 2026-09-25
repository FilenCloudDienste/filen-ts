import { useRef, useState, type ChangeEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { normalizeTextFileName, runCreateTextFile } from "@/features/drive/lib/createTextFile"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
import { driveListingQueryUpdate, useHeicUploadConvertPreferenceQuery } from "@/features/drive/queries/drive"
import { type PreviewSource, drivePreviewSources } from "@/features/preview/lib/previewSource"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface UseUploadMenuActionsParams {
	// The directory uploads and new text files land in, null for My Drive's root.
	parentUuid: string | null
	disabled: boolean
	openPreview: (sources: PreviewSource[], index: number) => void
	hiddenNotice: boolean
	// Prefix of the hidden inputs' test ids, so tests can tell one host's pickers from another's.
	testIdPrefix?: string
}

export interface UploadMenuActions {
	pickFiles: () => void
	pickDirectory: () => void
	newTextFile: () => void
	heicConvert: boolean
	setHeicConvert: (next: boolean) => void
	// A picker or the text-file dialog is in use, so the host has to stay mounted until it settles.
	busy: boolean
	// The hidden pickers and the text-file name dialog. Mounted beside the menu, never inside its popup:
	// the popup unmounts on close, before a picker's change or the dialog's submit arrives.
	host: ReactNode
}

// Each file/directory picker is a hidden <input type="file">, triggered via ref+click (mirrors
// masterKeysFileField.tsx) — its value is reset after every pick so choosing the exact same
// file(s)/directory again still fires change. "New text file" instead opens a name dialog (reusing
// the shared InputDialog primitive, same validation convention as newDirectory.tsx). Behind the upload
// menus (uploadMenu.tsx) and the sidebar tree's menu, which uploads into whichever node it was opened on.
export function useUploadMenuActions({
	parentUuid,
	disabled,
	openPreview,
	hiddenNotice,
	testIdPrefix = "drive-upload"
}: UseUploadMenuActionsParams): UploadMenuActions {
	const { t } = useTranslation("drive")
	const inputRef = useRef<HTMLInputElement>(null)
	const directoryInputRef = useRef<HTMLInputElement>(null)
	const [textFileDialogOpen, setTextFileDialogOpen] = useState(false)
	const [textFilePending, setTextFilePending] = useState(false)
	// From a picker's click until its change or cancel.
	const [pickerOpen, setPickerOpen] = useState(false)
	const heicConvertQuery = useHeicUploadConvertPreferenceQuery()

	function settlePicker(): void {
		setPickerOpen(false)
	}

	// Attached through ref callbacks rather than a mount effect: a host can mount after this hook does
	// (the sidebar tree mounts its own only while in use). React has no onCancel for inputs, so a picker
	// dismissed without a pick is heard natively.
	function attachFilesInput(input: HTMLInputElement | null): (() => void) | undefined {
		inputRef.current = input

		if (input === null) {
			return undefined
		}

		input.addEventListener("cancel", settlePicker)

		return () => {
			input.removeEventListener("cancel", settlePicker)
		}
	}

	function attachDirectoryInput(input: HTMLInputElement | null): (() => void) | undefined {
		directoryInputRef.current = input

		if (input === null) {
			return undefined
		}

		// `webkitdirectory` has no slot in React's InputHTMLAttributes (it IS a real HTMLInputElement
		// property — lib.dom.d.ts declares it — just not one React's JSX typings expose), so it's set
		// imperatively on the real DOM node instead of a typed-spread hack.
		input.webkitdirectory = true
		input.addEventListener("cancel", settlePicker)

		return () => {
			input.removeEventListener("cancel", settlePicker)
		}
	}

	function handleFilesChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startUploads(files, parentUuid)
		e.target.value = ""
		settlePicker()
	}

	function handleDirectoryChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void startDirectoryUpload({ kind: "files", files }, parentUuid)
		e.target.value = ""
		settlePicker()
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
			setPickerOpen(true)
			inputRef.current?.click()
		},
		pickDirectory: () => {
			setPickerOpen(true)
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
		busy: pickerOpen || textFileDialogOpen || textFilePending,
		host: (
			<>
				<input
					data-testid={`${testIdPrefix}-files-input`}
					ref={attachFilesInput}
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
					data-testid={`${testIdPrefix}-directory-input`}
					ref={attachDirectoryInput}
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
