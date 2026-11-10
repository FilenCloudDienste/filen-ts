import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { driveItemName } from "@filen/shared"
import { runCreateFile, type CreateFileOutcome } from "@/features/drive/lib/createTextFile"
import {
	OFFICE_FILE_MIME,
	freeOfficeFileName,
	normalizeOfficeFileName,
	officeFileClass,
	officeFileBytes,
	type NewOfficeKind
} from "@/features/drive/lib/createOfficeFile"
import { nameTakenInDirectory } from "@/features/drive/lib/nameTaken"
import { notifyIfNameIsHidden } from "@/features/drive/lib/hiddenNameNotice"
import { cachedListing, driveListingQueryUpdate, isDriveListingCurrent } from "@/features/drive/queries/drive"
import { type DriveItem } from "@/features/drive/lib/item"
import { browserLanguage } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { loadedOfficeSetting } from "@/features/office/lib/officeSettings"
import { sdkApi } from "@/lib/sdk/client"
import { asErrorDTO } from "@/lib/sdk/errors"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { InputDialog } from "@/components/dialogs/inputDialog"

export interface UseNewOfficeFileParams {
	// The directory the file lands in, null for My Drive's root.
	parentUuid: string | null
	openPreview: (items: DriveItem[], index: number) => void
	hiddenNotice: boolean
}

export interface NewOfficeFile {
	open: (kind: NewOfficeKind) => void
	// The name dialog is open or its create is running.
	busy: boolean
	host: ReactNode
}

// The dialog's wording by what the kind makes.
const WORDING = {
	document: { title: "driveNewDocxTitle", body: "driveNewDocxBody", untitled: "driveNewDocxUntitled" },
	spreadsheet: { title: "driveNewXlsxTitle", body: "driveNewXlsxBody", untitled: "driveNewXlsxUntitled" },
	presentation: { title: "driveNewPptxTitle", body: "driveNewPptxBody", untitled: "driveNewPptxUntitled" }
} as const

// The names a listing the socket keeps current already holds (lowercased), so the dialog can start on a free one
// without a request; empty when it is not current (the submit checks then).
function currentNames(parentUuid: string | null): ReadonlySet<string> {
	if (!isDriveListingCurrent(parentUuid)) {
		return new Set()
	}

	return new Set((cachedListing("drive", parentUuid) ?? []).map(item => driveItemName(item).toLowerCase()))
}

// New ▸ Office: a name dialog starting on a localized "Untitled …" with its base name selected, then a blank
// document from @filen/office's templates uploaded under it and opened in its editor. A taken name is refused
// inline: uploading onto it would make a new version of that file.
export function useNewOfficeFile({ parentUuid, openPreview, hiddenNotice }: UseNewOfficeFileParams): NewOfficeFile {
	const { t } = useTranslation("drive")
	const [kind, setKind] = useState<NewOfficeKind | null>(null)
	const [shownKind, setShownKind] = useState<NewOfficeKind>("docx")
	const [pending, setPending] = useState(false)
	// The normalized name the last submit found taken; the error stays until the name changes.
	const [takenName, setTakenName] = useState<string | null>(null)

	// Read in the render that opens the dialog, which already points at the directory the action chose.
	const fileClass = officeFileClass(shownKind)
	const wording = WORDING[fileClass]
	const untitled = t(wording.untitled)
	const initialName = kind === null ? "" : freeOfficeFileName(untitled, kind, currentNames(parentUuid))

	function normalized(name: string): string {
		return normalizeOfficeFileName(name.trim(), shownKind)
	}

	function isTaken(name: string): boolean {
		return takenName !== null && normalized(name) === takenName
	}

	async function handleSubmit(name: string): Promise<void> {
		const fileName = normalized(name)

		setPending(true)

		const paper = (await loadedOfficeSetting("paperSize")) ?? undefined
		const outcome: CreateFileOutcome = await officeFileBytes(shownKind, {
			locale: browserLanguage(),
			sheetName: t("driveNewXlsxSheetName"),
			paper
		}).then(
			bytes =>
				runCreateFile(
					{
						uploadFileBytes: (parent, data, uploadName, mime) => sdkApi.uploadFileBytes(parent, data, uploadName, mime),
						patchListing: driveListingQueryUpdate,
						nameTaken: nameTakenInDirectory
					},
					parentUuid,
					fileName,
					bytes,
					OFFICE_FILE_MIME[shownKind]
				),
			(e: unknown) => ({ status: "error", dto: asErrorDTO(e) })
		)

		setPending(false)

		if (outcome.status === "taken") {
			setTakenName(fileName)
			return
		}

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		setKind(null)
		notifyIfNameIsHidden(fileName, "created", hiddenNotice)
		openPreview([outcome.item], 0)
	}

	return {
		open: next => {
			setTakenName(null)
			setShownKind(next)
			setKind(next)
		},
		busy: kind !== null || pending,
		host: (
			<InputDialog
				open={kind !== null}
				pending={pending}
				// The kind shown stays while the dialog closes, so its title does not change mid-animation.
				title={t(wording.title)}
				body={t(wording.body)}
				label={t("driveNewOfficeFileLabel")}
				initialValue={initialName}
				selectBaseName
				submitLabel={t("driveNewOfficeFileSubmit")}
				validate={name => name.trim().length > 0 && !isTaken(name)}
				errorFor={name => (isTaken(name) ? t("driveNewFileNameTaken") : null)}
				onOpenChange={open => {
					if (!open) {
						setKind(null)
					}
				}}
				onSubmit={value => {
					void handleSubmit(value)
				}}
			/>
		)
	}
}
