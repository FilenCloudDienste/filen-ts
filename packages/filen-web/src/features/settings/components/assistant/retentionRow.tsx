import { useState } from "react"
import { useTranslation } from "react-i18next"
import { SettingsSelectRow } from "@/features/settings/components/settingRows"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { setHistoryRetention, useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import { useHistoryRetention } from "@/features/assistant/store/historyRetention"
import {
	retentionIsStricter,
	retentionRemovals,
	HISTORY_RETENTION_VALUES,
	type HistoryRetention
} from "@/features/assistant/store/history.logic"
import type { SettingsKey } from "@/lib/i18n"

const RETENTION_LABEL_KEYS: Record<HistoryRetention, SettingsKey> = {
	off: "settingsAssistantRetentionOff",
	"1d": "settingsAssistantRetention1Day",
	"7d": "settingsAssistantRetention7Days",
	"30d": "settingsAssistantRetention30Days",
	forever: "settingsAssistantRetentionForever"
}

// A choice waiting for confirmation, with how many saved conversations it removes (null: the list was never read, so
// the count is unknown).
interface PendingChoice {
	retention: HistoryRetention
	removes: number | null
}

// How long saved assistant conversations are kept. A choice that removes saved conversations asks first, counting
// them from the list already held (no read); with none held, a stricter choice asks without a count. Cancel keeps the
// old value.
export function RetentionRow() {
	const { t } = useTranslation(["settings", "common"])
	const retention = useHistoryRetention()
	const [pending, setPending] = useState<PendingChoice | null>(null)

	function choose(next: HistoryRetention): void {
		if (next === retention) {
			return
		}

		const { conversations, currentId } = useAssistantHistoryStore.getState()
		const removes = retentionRemovals(conversations, next, Date.now(), currentId)

		if (removes === 0 || (removes === null && !retentionIsStricter(next, retention))) {
			setHistoryRetention(next)

			return
		}

		setPending({ retention: next, removes })
	}

	function body(choice: PendingChoice): string {
		if (choice.removes !== null) {
			return t("settingsAssistantRetentionConfirmBody", { count: choice.removes })
		}

		return t(choice.retention === "off" ? "settingsAssistantRetentionConfirmOffBody" : "settingsAssistantRetentionConfirmShorterBody")
	}

	return (
		<>
			<SettingsSelectRow
				label={t("settingsAssistantRetention")}
				description={t("settingsAssistantRetentionDescription")}
				id="assistant-retention"
				helpId="assistantRetention"
				options={HISTORY_RETENTION_VALUES.map(value => ({ value, label: t(RETENTION_LABEL_KEYS[value]) }))}
				value={retention}
				disabled={false}
				onChange={choose}
			/>
			<ConfirmDialog
				open={pending !== null}
				pending={false}
				title={t("settingsAssistantRetentionConfirmTitle")}
				body={pending === null ? "" : body(pending)}
				confirmLabel={t("settingsAssistantRetentionConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setPending(null)
					}
				}}
				onConfirm={() => {
					if (pending !== null) {
						setHistoryRetention(pending.retention)
					}

					setPending(null)
				}}
			/>
		</>
	)
}
