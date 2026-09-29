import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { downloadBlob } from "@/lib/downloadBlob"
import { gdprInfoToJson } from "@/features/settings/lib/gdprExport"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsRow } from "@/features/settings/components/settingsLayout"

// Read-only fetch (getUserInfo/getUserEvents/getGdprInfo mutate nothing, so they are safe to
// e2e-invoke live) → client-built JSON blob → the shared download primitive (downloadBlob.ts), same anchor-click
// convention as notes export and the security rows' text exports. No dialog, no confirmation —
// this never mutates account state.
function GdprExportRow() {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const [pending, setPending] = useState(false)

	async function handleExport(): Promise<void> {
		setPending(true)
		try {
			const info = await sdkApi.getGdprInfo()
			downloadBlob(`filen-data-export.${String(Date.now())}.json`, new Blob([gdprInfoToJson(info)], { type: "application/json" }))
			toast.success(t("settingsGdprSuccess"))
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			setPending(false)
		}
	}

	return (
		<SettingsRow
			label={t("settingsGdprTitle")}
			description={t("settingsGdprDescription")}
		>
			<Button
				type="button"
				variant="outline"
				disabled={pending || !isOnline}
				title={!isOnline ? t("common:offlineActionDisabled") : undefined}
				onClick={() => {
					void handleExport()
				}}
			>
				{pending && <Spinner data-icon="inline-start" />}
				{t("settingsGdprExportAction")}
			</Button>
		</SettingsRow>
	)
}

export { GdprExportRow }
