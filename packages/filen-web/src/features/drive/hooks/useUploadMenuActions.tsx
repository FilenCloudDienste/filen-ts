import { useRef, useState, type ChangeEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { startUploads } from "@/features/drive/lib/upload"
import { startDirectoryUpload } from "@/features/drive/lib/uploadDirectory"
import { nativeTransfersAvailable } from "@/features/transfers/lib/nativeHost"
import { pickNativeUpload, startNativeUploads } from "@/features/transfers/lib/nativeTransfers"
import { normalizeTextFileName, runCreateTextFile } from "@/features/drive/lib/createTextFile"
import { nameTakenInDirectory } from "@/features/drive/lib/nameTaken"
import { type NewOfficeKind } from "@/features/drive/lib/createOfficeFile"
import { useNewOfficeFile } from "@/features/drive/hooks/useNewOfficeFile"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { driveListingQueryUpdate, heicUploadConvertPreferenceCached } from "@/features/drive/queries/drive"
import { type DriveItem } from "@/features/drive/lib/item"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface UseUploadMenuActionsParams {
	// The directory uploads and new text files land in, null for My Drive's root.
	parentUuid: string | null
	disabled: boolean
	openPreview: (items: DriveItem[], index: number) => void
	hiddenNotice: boolean
	// Prefix of the hidden inputs' test ids, so tests can tell one host's pickers from another's.
	// "drive-upload" when omitted.
	testIdPrefix?: string
}

export interface UploadMenuActions {
	pickFiles: () => void
	pickDirectory: () => void
	newTextFile: () => void
	newOffice: (kind: NewOfficeKind) => void
	// A picker or a name dialog is in use, so the host has to stay mounted until it settles.
	busy: boolean
	// The hidden pickers and the name dialogs. Mounted beside the menu, never inside its popup:
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
	testIdPrefix
}: UseUploadMenuActionsParams): UploadMenuActions {
	const { t } = useTranslation("drive")
	// Not a destructuring default, which the React Compiler cannot lower.
	const testIds = testIdPrefix ?? "drive-upload"
	const inputRef = useRef<HTMLInputElement>(null)
	const directoryInputRef = useRef<HTMLInputElement>(null)
	const [textFileDialogOpen, setTextFileDialogOpen] = useState(false)
	const [textFilePending, setTextFilePending] = useState(false)
	// The normalized name the last submit found taken; the error stays until the name changes.
	const [takenTextFileName, setTakenTextFileName] = useState<string | null>(null)
	// From a picker's click until its change or cancel.
	const [pickerOpen, setPickerOpen] = useState(false)
	const office = useNewOfficeFile({ parentUuid, openPreview, hiddenNotice })

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

	// On desktop with HEIC conversion off, the desktop app's own open dialog: the picked paths go straight to its
	// native host. Otherwise the hidden input, whose click must stay inside the user's gesture, so the preference is
	// read from what is already loaded.
	function pick(kind: "file" | "directory", input: HTMLInputElement | null): void {
		setPickerOpen(true)

		if (nativeTransfersAvailable() && heicUploadConvertPreferenceCached() === false) {
			void pickNativeUpload(kind, parentUuid).then(settlePicker)

			return
		}

		input?.click()
	}

	// On desktop the native host uploads what it can (startNativeUploads routes HEIC files when they convert).
	function handleFilesChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void (nativeTransfersAvailable() ? startNativeUploads(files, parentUuid) : startUploads(files, parentUuid))
		e.target.value = ""
		settlePicker()
	}

	function handleDirectoryChosen(e: ChangeEvent<HTMLInputElement>): void {
		const files = Array.from(e.target.files ?? [])
		void (nativeTransfersAvailable()
			? startNativeUploads(files, parentUuid, { asDirectory: true })
			: startDirectoryUpload({ kind: "files", files }, parentUuid))
		e.target.value = ""
		settlePicker()
	}

	function isTakenTextFileName(name: string): boolean {
		return takenTextFileName !== null && normalizeTextFileName(name.trim()) === takenTextFileName
	}

	async function handleTextFileSubmit(name: string): Promise<void> {
		setTextFilePending(true)

		// The NORMALIZED name is what actually lands (and what the row will show), so it is also what
		// the hidden-name check below has to judge.
		const normalized = normalizeTextFileName(name.trim())
		const outcome = await runCreateTextFile(
			{
				uploadFileBytes: (parent, data, fileName, mime) => sdkApi.uploadFileBytes(parent, data, fileName, mime),
				patchListing: driveListingQueryUpdate,
				nameTaken: nameTakenInDirectory
			},
			parentUuid,
			normalized
		)

		setTextFilePending(false)

		if (outcome.status === "taken") {
			setTakenTextFileName(normalized)
			return
		}

		if (outcome.status === "error") {
			// Dialog stays open on error so the user can fix the name and retry — mirrors newDirectory.tsx's
			// identical convention.
			toast.error(errorLabel(outcome.dto))
			return
		}

		setTextFileDialogOpen(false)
		notifyIfNameIsHidden(normalized, "created", hiddenNotice)
		// Opens the editor immediately (mobile parity — useDriveUpload.ts's createTextFile does the
		// same). A single-item frozen snapshot, same as a lone previewable item's own open path
		// (directoryListing.tsx's handleOpen).
		openPreview([outcome.item], 0)
	}

	return {
		pickFiles: () => {
			pick("file", inputRef.current)
		},
		pickDirectory: () => {
			pick("directory", directoryInputRef.current)
		},
		newTextFile: () => {
			setTakenTextFileName(null)
			setTextFileDialogOpen(true)
		},
		newOffice: office.open,
		busy: pickerOpen || textFileDialogOpen || textFilePending || office.busy,
		host: (
			<>
				<input
					data-testid={`${testIds}-files-input`}
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
					data-testid={`${testIds}-directory-input`}
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
					validate={name => name.trim().length > 0 && !isTakenTextFileName(name)}
					errorFor={name => (isTakenTextFileName(name) ? t("driveNewFileNameTaken") : null)}
					onOpenChange={setTextFileDialogOpen}
					onSubmit={value => {
						void handleTextFileSubmit(value)
					}}
				/>
				{office.host}
			</>
		)
	}
}
