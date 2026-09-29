import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { ChangePasswordRow } from "@/features/settings/components/security/changePassword"
import { TwoFactorRow } from "@/features/settings/components/security/twoFactor"
import { ExportMasterKeysRow } from "@/features/settings/components/security/exportMasterKeys"
import { DeleteAccountRow } from "@/features/settings/components/security/deleteAccount"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Guard inherited from `_app` (a session already exists by the time this route renders). Every
// row independently reads useAccountQuery (react-query dedupes the shared ["account"] key — one
// request, any number of subscribers), but the page gates on ONE top-level branch (mirrors
// filen-mobile's security.tsx) so every row mounts only once the account has genuinely loaded, rather
// than each re-deriving the same tri-state branch. The gate is on the data, not the status: a failed
// background read keeps the cached account, and unmounting over it would drop the 2FA row's one-time
// recovery key.
export const Route = createFileRoute("/_app/settings/security")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionSecurity"), i18n.t("common:settings")] }),
	component: SecurityPage
})

function SecurityPage() {
	const { t } = useTranslation(["auth", "settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<SettingsPage
			icon={ShieldIcon}
			title={t("securityTitle")}
		>
			{accountQuery.data !== undefined ? (
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
			) : accountQuery.status === "error" ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia>
							<ShieldIcon />
						</EmptyMedia>
						<EmptyTitle>{t("securityLoadError")}</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						<Button
							variant="outline"
							onClick={() => {
								void accountQuery.refetch()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<LoadingState size="lg" />
			)}
		</SettingsPage>
	)
}
