import { useTranslation } from "react-i18next"
import { setHeicUploadConvertPreference } from "@/features/drive/lib/heicUpload"
import { useHeicUploadConvertPreferenceQuery } from "@/features/drive/queries/drive"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

// Advanced → uploads. The HEIC/HEIF-to-JPG conversion applies to every upload path; uploads read the
// stored preference themselves, so this card only writes it.
function UploadsCard() {
	const { t } = useTranslation("settings")
	const query = useHeicUploadConvertPreferenceQuery()

	async function setConvert(next: boolean): Promise<void> {
		await setHeicUploadConvertPreference(next)
		void query.refetch()
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsAdvancedUploadsTitle")}</CardTitle>
				<CardDescription>{t("settingsAdvancedUploadsDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col">
				<PreferenceToggleRow
					title={t("settingsConvertHeicToJpg")}
					description={t("settingsConvertHeicToJpgDescription")}
					checked={query.data ?? false}
					disabled={query.data === undefined}
					onCheckedChange={checked => {
						void setConvert(checked)
					}}
				/>
			</CardContent>
		</Card>
	)
}

export { UploadsCard }
