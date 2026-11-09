import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
import { useHeicUploadConvertPreferenceQuery } from "@/features/drive/queries/drive"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

// Advanced → uploads. The HEIC/HEIF-to-JPG conversion applies to every upload path; uploads read the
// stored preference themselves, so this row only writes it.
function UploadsRow() {
	const { t } = useTranslation("settings")
	const query = useHeicUploadConvertPreferenceQuery()

	function setConvert(next: boolean): void {
		setHeicUploadConvertPreference(next).then(
			() => {
				void query.refetch()
			},
			() => {
				toast.error(t("settingsDocumentsSaveFailed"))
			}
		)
	}

	return (
		<PreferenceToggleRow
			title={t("settingsConvertHeicToJpg")}
			description={t("settingsConvertHeicToJpgDescription")}
			checked={query.data ?? false}
			disabled={query.data === undefined}
			onCheckedChange={checked => {
				setConvert(checked)
			}}
		/>
	)
}

export { UploadsRow }
