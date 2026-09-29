import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldIcon } from "lucide-react"
import { ChangePasswordRow } from "@/features/settings/components/security/changePassword"
import { TwoFactorRow } from "@/features/settings/components/security/twoFactor"
import { ExportMasterKeysRow } from "@/features/settings/components/security/exportMasterKeys"
import { DeleteAccountRow } from "@/features/settings/components/security/deleteAccount"
import { AccountGate } from "@/features/settings/components/accountGate"
import { SettingsGroup } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Guard inherited from `_app` (a session already exists by the time this route renders).
export const Route = createFileRoute("/_app/settings/security")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionSecurity"), i18n.t("common:settings")] }),
	component: SecurityPage
})

function SecurityPage() {
	const { t } = useTranslation(["auth", "settings"])

	return (
		<AccountGate
			icon={ShieldIcon}
			title={t("securityTitle")}
		>
			{accountQuery => (
				<>
					<SettingsGroup title={t("settings:settingsGroupSignIn")}>
						<ChangePasswordRow />
						<TwoFactorRow accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup title={t("settings:settingsGroupRecovery")}>
						<ExportMasterKeysRow accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup
						title={t("settings:settingsGroupDangerZone")}
						variant="danger"
					>
						<DeleteAccountRow accountQuery={accountQuery} />
					</SettingsGroup>
				</>
			)}
		</AccountGate>
	)
}
