import { useTranslation } from "react-i18next"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { setHistoryRetention } from "@/features/assistant/store/conversationHistory"
import { useHistoryRetention } from "@/features/assistant/store/historyRetention"
import { HISTORY_RETENTION_VALUES, type HistoryRetention } from "@/features/assistant/store/history.logic"
import type { SettingsKey } from "@/lib/i18n"

const RETENTION_LABEL_KEYS: Record<HistoryRetention, SettingsKey> = {
	off: "settingsAssistantRetentionOff",
	"1d": "settingsAssistantRetention1Day",
	"7d": "settingsAssistantRetention7Days",
	"30d": "settingsAssistantRetention30Days",
	forever: "settingsAssistantRetentionForever"
}

// How long saved assistant conversations are kept. A change applies at once: Off removes every saved conversation, a
// shorter limit the ones older than it.
export function RetentionRow() {
	const { t } = useTranslation("settings")
	const retention = useHistoryRetention()

	return (
		<SettingsSelectRow
			label={t("settingsAssistantRetention")}
			description={t("settingsAssistantRetentionDescription")}
			id="assistant-retention"
			options={HISTORY_RETENTION_VALUES.map(value => ({ value, label: t(RETENTION_LABEL_KEYS[value]) }))}
			value={retention}
			disabled={false}
			onChange={setHistoryRetention}
		/>
	)
}
