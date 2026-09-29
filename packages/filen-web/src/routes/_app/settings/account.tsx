import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { UserIcon } from "lucide-react"
import { ProfileHeader } from "@/features/settings/components/account/profileHeader"
import { NicknameRow } from "@/features/settings/components/account/nicknameRow"
import { ChangeEmailRow } from "@/features/settings/components/account/changeEmail"
import { PersonalInfoRow } from "@/features/settings/components/account/personalInfoRow"
import { StorageBreakdownRow } from "@/features/settings/components/account/storageBreakdownRow"
import { GdprExportRow } from "@/features/settings/components/account/gdprExportRow"
import { AccountPreferencesRows } from "@/features/settings/components/account/accountPreferencesRows"
import { DeleteAllVersionsRow } from "@/features/settings/components/account/deleteAllVersionsRow"
import { DeleteAllItemsRow } from "@/features/settings/components/account/deleteAllItemsRow"
import { AccountGate } from "@/features/settings/components/accountGate"
import { SettingsGroup } from "@/features/settings/components/settingsLayout"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

export const Route = createFileRoute("/_app/settings/account")({
	head: routeHead({ title: () => [i18n.t("settings:settingsSectionAccount"), i18n.t("common:settings")] }),
	component: AccountPage
})

function AccountPage() {
	const { t } = useTranslation("settings")

	return (
		<AccountGate
			icon={UserIcon}
			title={t("settingsSectionAccount")}
		>
			{accountQuery => (
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
		</AccountGate>
	)
}
