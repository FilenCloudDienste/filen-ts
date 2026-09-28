import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { UserIcon } from "lucide-react"
import { useAccountQuery } from "@/queries/account"
import { ProfileHeader } from "@/features/settings/components/account/profileHeader"
import { NicknameRow } from "@/features/settings/components/account/nicknameRow"
import { ChangeEmailRow } from "@/features/settings/components/account/changeEmail"
import { PersonalInfoRow } from "@/features/settings/components/account/personalInfoRow"
import { StorageBreakdownRow } from "@/features/settings/components/account/storageBreakdownRow"
import { GdprExportRow } from "@/features/settings/components/account/gdprExportRow"
import { AccountPreferencesRows } from "@/features/settings/components/account/accountPreferencesRows"
import { DeleteAllVersionsRow } from "@/features/settings/components/account/deleteAllVersionsRow"
import { DeleteAllItemsRow } from "@/features/settings/components/account/deleteAllItemsRow"
import { SettingsGroup, SettingsPage } from "@/features/settings/components/settingsLayout"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Same one-top-level-gate shape as the Security page: every row independently reads
// useAccountQuery (dedupe via the shared ["account"] key), but the page gates on ONE
// pending/error branch so every row mounts only once the account has genuinely loaded.
export const Route = createFileRoute("/_app/settings/account")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAccount"), i18n.t("common:settings")] }),
	component: AccountPage
})

function AccountPage() {
	const { t } = useTranslation(["settings", "common"])
	const accountQuery = useAccountQuery()

	return (
		<SettingsPage
			icon={UserIcon}
			title={t("settingsSectionAccount")}
		>
			{accountQuery.status === "pending" ? (
				<LoadingState size="lg" />
			) : accountQuery.status === "error" ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<UserIcon />
						</EmptyMedia>
						<EmptyTitle>{t("settingsAccountLoadError")}</EmptyTitle>
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
				<>
					<ProfileHeader accountQuery={accountQuery} />
					<SettingsGroup title={t("settingsGroupProfile")}>
						<NicknameRow accountQuery={accountQuery} />
						<ChangeEmailRow accountQuery={accountQuery} />
						<PersonalInfoRow accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup title={t("settingsStorageTitle")}>
						<StorageBreakdownRow accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup title={t("settingsGroupYourData")}>
						<GdprExportRow />
					</SettingsGroup>
					<SettingsGroup title={t("settingsPreferencesTitle")}>
						<AccountPreferencesRows accountQuery={accountQuery} />
					</SettingsGroup>
					<SettingsGroup
						title={t("settingsGroupDangerZone")}
						variant="danger"
					>
						<DeleteAllVersionsRow accountQuery={accountQuery} />
						<DeleteAllItemsRow accountQuery={accountQuery} />
					</SettingsGroup>
				</>
			)}
		</SettingsPage>
	)
}
