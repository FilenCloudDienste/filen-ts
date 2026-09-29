import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runPreferenceToggle } from "@/features/settings/components/account/accountPreferences.logic"
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
	// Only offline earns the tooltip — an in-flight toggle clears itself a moment later.
	const offlineReason = !isOnline ? t("common:offlineActionDisabled") : undefined

	return (
		<>
			<AccountToggleRow
				title={t("settingsVersioningTitle")}
				description={t("settingsVersioningDescription")}
				checked={versioningEnabled}
				isOnline={isOnline}
				offlineReason={offlineReason}
				setEnabled={enabled => sdkApi.setVersioningEnabled(enabled)}
				patchKey="versioningEnabled"
			/>
			<AccountToggleRow
				title={t("settingsLoginAlertsTitle")}
				description={t("settingsLoginAlertsDescription")}
				checked={loginAlertsEnabled}
				isOnline={isOnline}
				offlineReason={offlineReason}
				setEnabled={enabled => sdkApi.setLoginAlertsEnabled(enabled)}
				patchKey="loginAlertsEnabled"
			/>
		</>
	)
}

// A toggle write reaches the SDK immediately (no outbox), so it's proactively disabled offline.
function AccountToggleRow({
	title,
	description,
	checked,
	isOnline,
	offlineReason,
	setEnabled,
	patchKey
}: {
	title: string
	description: string
	checked: boolean
	isOnline: boolean
	offlineReason: string | undefined
	setEnabled: (enabled: boolean) => Promise<void>
	patchKey: "versioningEnabled" | "loginAlertsEnabled"
}) {
	const [pending, setPending] = useState(false)

	async function handleChange(next: boolean): Promise<void> {
		setPending(true)
		const outcome = await runPreferenceToggle(
			{
				setEnabled,
				patch: enabled => {
					accountQueryUpdate(prev => ({ ...prev, [patchKey]: enabled }))
				}
			},
			next
		)
		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
		setPending(false)
	}

	return (
		<PreferenceToggleRow
			title={title}
			description={description}
			checked={checked}
			disabled={pending || !isOnline}
			disabledReason={offlineReason}
			onCheckedChange={next => {
				void handleChange(next)
			}}
		/>
	)
}

export { AccountPreferencesRows }
