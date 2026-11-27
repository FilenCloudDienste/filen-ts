import { useTranslation } from "react-i18next"
import { useOfficeSettings } from "@/features/office/lib/officeSettings"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"
import { saveSyncedOfficeSetting } from "@/features/settings/components/office/syncedSetting"
import { assistantHiddenPreference, useAssistantHidden } from "@/features/assistant/store/assistantHidden"
import { useIsOnline } from "@/lib/useIsOnline"

// Hides every assistant entry point on every device: synced with the office settings (written, like those, only once
// the file was read and only online), and kept on this device for the next boot. Applies here at once.
export function HideAssistantRow() {
	const { t } = useTranslation(["settings", "common"])
	const hidden = useAssistantHidden()
	const { loaded } = useOfficeSettings()
	const online = useIsOnline()

	return (
		<PreferenceToggleRow
			title={t("settingsAssistantHide")}
			helpId="hideAssistant"
			description={t("settingsAssistantHideDescription")}
			checked={hidden}
			disabled={!loaded || !online}
			disabledReason={online ? undefined : t("common:offlineActionDisabled")}
			onCheckedChange={checked => {
				assistantHiddenPreference.set(checked)
				saveSyncedOfficeSetting("hideAssistant", checked)
			}}
		/>
	)
}
