import { useTranslation } from "react-i18next"
import { DEFAULT_SHOW_DOT_FILEN, setShowDotFilen } from "@/features/drive/lib/preferences"
import { useShowDotFilenPreferenceQuery } from "@/features/drive/queries/drive"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

// Advanced → drive. Every listing, tree and picker observes the same query, so the refetch re-renders them without
// fetching a listing again (the filter is display-only).
function DotFilenRow() {
	const { t } = useTranslation("settings")
	const query = useShowDotFilenPreferenceQuery()

	async function setShow(next: boolean): Promise<void> {
		await setShowDotFilen(next)
		void query.refetch()
	}

	return (
		<PreferenceToggleRow
			title={t("settingsShowDotFilen")}
			description={t("settingsShowDotFilenDescription")}
			checked={query.data ?? DEFAULT_SHOW_DOT_FILEN}
			disabled={query.data === undefined}
			onCheckedChange={checked => {
				void setShow(checked)
			}}
		/>
	)
}

export { DotFilenRow }
