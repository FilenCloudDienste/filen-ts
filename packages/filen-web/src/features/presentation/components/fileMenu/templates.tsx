import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { FilePlusIcon } from "lucide-react"
import { nameCollisionKey } from "@filen/shared"
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { OFFICE_FILE_MIME, freeOfficeFileName, officeFileBytes } from "@/features/drive/lib/createOfficeFile"
import { runCreateFile } from "@/features/drive/lib/createTextFile"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { takenNamesInDirectory } from "@/features/drive/lib/nameTaken"
import { driveListingQueryUpdate, normalizeParentUuid } from "@/features/drive/queries/drive"
import { usePreviewReplace } from "@/features/preview/lib/previewReplace"
import type { PresentationFileMenuEntryProps } from "@/features/presentation/components/fileMenu/save"
import { browserLanguage } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import { sdkApi } from "@/lib/sdk/client"
import { useIsOnline } from "@/lib/useIsOnline"

// File ▸ New presentation: a blank presentation (the New ▸ Office template, .pptx or .odp) made beside this file and
// opened in its place, asking first about this one's unsaved edits. Offered where a copy may be saved beside the file
// (a drive file the user may write beside). The free name comes from the directory's listing (cached, read once).

type Kind = "pptx" | "odp"

export function PresentationTemplatesEntries({ context }: PresentationFileMenuEntryProps): ReactNode {
	const { t } = useTranslation(["preview", "drive"])
	const online = useIsOnline()
	const beside = context.saveCopy
	const replace = usePreviewReplace()

	if (beside === undefined) return null

	const create = async (kind: Kind, open: (item: DriveItem) => void): Promise<void> => {
		const base = asDirectoryOrFile(beside.item)

		if (base.type !== "file") return

		try {
			const parent = normalizeParentUuid(base.data.parent, currentRootUuid())
			const taken = await takenNamesInDirectory(parent)
			const name = freeOfficeFileName(t("drive:driveNewPptxUntitled"), kind, taken)
			const bytes = await officeFileBytes(kind, { locale: browserLanguage(), sheetName: "" })
			const outcome = await runCreateFile(
				{
					uploadFileBytes: (parentUuid, data, uploadName, mime) => sdkApi.uploadFileBytes(parentUuid, data, uploadName, mime),
					patchListing: driveListingQueryUpdate,
					nameTaken: (_, candidate) => Promise.resolve(taken.has(nameCollisionKey(candidate)))
				},
				parent,
				name,
				bytes,
				OFFICE_FILE_MIME[kind]
			)

			if (outcome.status === "success") {
				toast.success(t("previewPptxNewPresentationCreated", { name }))
				open(outcome.item)

				return
			}

			toast.error(outcome.status === "error" ? errorLabel(outcome.dto) : t("previewPptxNewPresentationFailed"))
		} catch (error) {
			log.error("presentation", "a new presentation was not created", error)
			toast.error(t("previewPptxNewPresentationFailed"))
		}
	}
	const choose = (kind: Kind): void => {
		context.close()

		const make = (open: (item: DriveItem) => void): void => {
			void create(kind, open)
		}

		if (replace === undefined)
			make(item => {
				beside.onOpenFile?.(item)
			})
		else replace(make)
	}

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger disabled={!online}>
				<FilePlusIcon />
				{t("previewPptxNewPresentation")}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent data-preview-surface>
				<DropdownMenuItem
					onClick={() => {
						choose("pptx")
					}}
				>
					{t("previewPptxNewPresentationPptx")}
				</DropdownMenuItem>
				<DropdownMenuItem
					onClick={() => {
						choose("odp")
					}}
				>
					{t("previewPptxNewPresentationOdp")}
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	)
}
