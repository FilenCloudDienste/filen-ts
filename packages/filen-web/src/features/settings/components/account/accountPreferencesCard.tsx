import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { sdkApi } from "@/lib/sdk/client"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { runPreferenceToggle, isPreferenceRowDisabled } from "@/features/settings/components/account/accountPreferences.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import type { AccountQuerySuccess } from "@/queries/account"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

interface AccountPreferencesCardProps {
	accountQuery: AccountQuerySuccess
}

interface PreferenceRowProps {
	title: string
	description: string
	checked: boolean
	pending: boolean
	onCheckedChange: (checked: boolean) => void
}

function PreferenceRow({ title, description, checked, pending, onCheckedChange }: PreferenceRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
			<div className="flex flex-col gap-0.5">
				<p className="text-sm font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			<Switch
				checked={checked}
				disabled={pending}
				aria-label={title}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	)
}

// Two safe, reversible toggles — versioning and login-alerts — each a direct flip with no confirm
// dialog (unlike the destructive delete cards below them on the Account page). `checked` is driven
// straight from the account query, never local optimistic state: a failed mutation is a no-op visually
// once `refetch` resolves back to the pre-toggle server value (accountPreferences.logic.ts).
function AccountPreferencesCard({ accountQuery }: AccountPreferencesCardProps) {
	const { t } = useTranslation("settings")
	const isOnline = useIsOnline()
	const { versioningEnabled, loginAlertsEnabled } = accountQuery.data
	const [versioningPending, setVersioningPending] = useState(false)
	const [loginAlertsPending, setLoginAlertsPending] = useState(false)

	async function handleVersioningChange(next: boolean): Promise<void> {
		setVersioningPending(true)
		const outcome = await runPreferenceToggle(
			{ setEnabled: enabled => sdkApi.setVersioningEnabled(enabled), refetch: () => accountQuery.refetch() },
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
			{ setEnabled: enabled => sdkApi.setLoginAlertsEnabled(enabled), refetch: () => accountQuery.refetch() },
			next
		)
		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
		setLoginAlertsPending(false)
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t("settingsPreferencesTitle")}</CardTitle>
				<CardDescription>{t("settingsPreferencesDescription")}</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col divide-y divide-border/60">
				<PreferenceRow
					title={t("settingsVersioningTitle")}
					description={t("settingsVersioningDescription")}
					checked={versioningEnabled}
					pending={isPreferenceRowDisabled(versioningPending, isOnline)}
					onCheckedChange={next => {
						void handleVersioningChange(next)
					}}
				/>
				<PreferenceRow
					title={t("settingsLoginAlertsTitle")}
					description={t("settingsLoginAlertsDescription")}
					checked={loginAlertsEnabled}
					pending={isPreferenceRowDisabled(loginAlertsPending, isOnline)}
					onCheckedChange={next => {
						void handleLoginAlertsChange(next)
					}}
				/>
			</CardContent>
		</Card>
	)
}

export { AccountPreferencesCard }
