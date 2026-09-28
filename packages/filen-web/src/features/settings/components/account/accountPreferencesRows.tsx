import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runPreferenceToggle, isPreferenceRowDisabled } from "@/features/settings/components/account/accountPreferences.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { accountQueryUpdate, type AccountQuerySuccess } from "@/queries/account"
import { PreferenceToggleRow } from "@/features/settings/components/settingRows"

interface AccountPreferencesRowsProps {
	accountQuery: AccountQuerySuccess
}

// Two safe, reversible toggles — versioning and login-alerts — each a direct flip with no confirm
// dialog (unlike the destructive delete rows below them on the Account page). `checked` is driven
// straight from the account query, never local optimistic state: a failed mutation never patches it,
// so the switch stays on the pre-toggle server value (accountPreferences.logic.ts).
function AccountPreferencesRows({ accountQuery }: AccountPreferencesRowsProps) {
	const { t } = useTranslation(["settings", "common"])
	const isOnline = useIsOnline()
	const { versioningEnabled, loginAlertsEnabled } = accountQuery.data
	const [versioningPending, setVersioningPending] = useState(false)
	const [loginAlertsPending, setLoginAlertsPending] = useState(false)
	// Only offline earns the tooltip — an in-flight toggle clears itself a moment later.
	const offlineReason = !isOnline ? t("common:offlineActionDisabled") : undefined

	async function handleVersioningChange(next: boolean): Promise<void> {
		setVersioningPending(true)
		const outcome = await runPreferenceToggle(
			{
				setEnabled: enabled => sdkApi.setVersioningEnabled(enabled),
				patch: enabled => {
					accountQueryUpdate(prev => ({ ...prev, versioningEnabled: enabled }))
				}
			},
			next
		)
		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
		setVersioningPending(false)
	}

	async function handleLoginAlertsChange(next: boolean): Promise<void> {
		setLoginAlertsPending(true)
		const outcome = await runPreferenceToggle(
			{
				setEnabled: enabled => sdkApi.setLoginAlertsEnabled(enabled),
				patch: enabled => {
					accountQueryUpdate(prev => ({ ...prev, loginAlertsEnabled: enabled }))
				}
			},
			next
		)
		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
		setLoginAlertsPending(false)
	}

	return (
		<>
			<PreferenceToggleRow
				title={t("settingsVersioningTitle")}
				description={t("settingsVersioningDescription")}
				checked={versioningEnabled}
				disabled={isPreferenceRowDisabled(versioningPending, isOnline)}
				disabledReason={offlineReason}
				onCheckedChange={next => {
					void handleVersioningChange(next)
				}}
			/>
			<PreferenceToggleRow
				title={t("settingsLoginAlertsTitle")}
				description={t("settingsLoginAlertsDescription")}
				checked={loginAlertsEnabled}
				disabled={isPreferenceRowDisabled(loginAlertsPending, isOnline)}
				disabledReason={offlineReason}
				onCheckedChange={next => {
					void handleLoginAlertsChange(next)
				}}
			/>
		</>
	)
}

export { AccountPreferencesRows }
