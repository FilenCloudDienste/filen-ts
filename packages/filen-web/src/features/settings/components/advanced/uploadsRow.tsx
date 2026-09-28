import { useTranslation } from "react-i18next"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
import { useHeicUploadConvertPreferenceQuery } from "@/features/drive/queries/drive"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

// Advanced → uploads. The HEIC/HEIF-to-JPG conversion applies to every upload path; uploads read the
// stored preference themselves, so this row only writes it.
function UploadsRow() {
	const { t } = useTranslation("settings")
	const query = useHeicUploadConvertPreferenceQuery()

	async function setConvert(next: boolean): Promise<void> {
		await setHeicUploadConvertPreference(next)
		void query.refetch()
	}

	return (
		<PreferenceToggleRow
			title={t("settingsConvertHeicToJpg")}
			description={t("settingsConvertHeicToJpgDescription")}
			checked={query.data ?? false}
			disabled={query.data === undefined}
			onCheckedChange={checked => {
				void setConvert(checked)
			}}
		/>
	)
}

export { UploadsRow }
