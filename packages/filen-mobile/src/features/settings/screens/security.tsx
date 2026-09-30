import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { LoadingView } from "@/components/ui/loadingView"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { LoadErrorEmpty } from "@/components/ui/listEmpty"
import { Fragment } from "react"
import useDismissStack from "@/hooks/useDismissStack"
import { useResolveClassNames } from "uniwind"
import SettingsHeader from "@/components/ui/settingsHeader"
import useAccountQuery, { accountQueryPatch } from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { confirmPrompt, inputPrompt } from "@/lib/promptFlow"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { writeTmpFile } from "@/lib/tmp"
import { shareTmpFile } from "@/lib/share"
import { usePrivacyScreenEnabled } from "@/features/settings/privacyScreen"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

function Security() {
	const { t } = useTranslation()
	const dismiss = useDismissStack()
	const textRed500 = useResolveClassNames("text-red-500")
	const [privacyScreen, setPrivacyScreen] = usePrivacyScreenEnabled()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("security")}
				icon="close"
				onDismiss={dismiss}
			/>
			<ScreenBody>
				{accountQuery.status === "pending" ? (
					<LoadingView />
				) : accountQuery.status === "error" ? (
					<LoadErrorEmpty
						title={t("could_not_load_account")}
						onRetry={() => accountQuery.refetch()}
					/>
				) : (
					<SettingsScrollView>
						<Group
							buttons={[
								{
									icon: "key-outline",
									title: t("change_password"),
									subTitle: t("change_password_description"),
									requiresOnline: true,
									onPress: async () => {
										const newPassword = await inputPrompt(
											{
												title: t("change_password"),
												message: t("enter_new_password"),
												cancelText: t("cancel"),
												okText: t("continue"),
												inputType: "secure-text"
											},
											{ tag: "settings", message: "change password new-password prompt failed" }
										)

										if (newPassword === null) {
											return
										}

										const confirmNewPassword = await inputPrompt(
											{
												title: t("change_password"),
												message: t("enter_confirm_new_password"),
												cancelText: t("cancel"),
												okText: t("continue"),
												inputType: "secure-text"
											},
											{ tag: "settings", message: "change password confirm-password prompt failed" }
										)

										if (confirmNewPassword === null) {
											return
										}

										if (newPassword !== confirmNewPassword) {
											alerts.error(t("passwords_do_not_match"))

											return
										}

										const currentPassword = await inputPrompt(
											{
												title: t("change_password"),
												message: t("enter_current_password"),
												cancelText: t("cancel"),
												okText: t("change"),
												inputType: "secure-text"
											},
											{ tag: "settings", message: "change password current-password prompt failed" }
										)

										if (currentPassword === null) {
											return
										}

										const changePasswordResult = await runWithLoading(async () => {
											const { authedSdkClient } = await auth.getSdkClients()

											await authedSdkClient.changePassword({
												currentPassword,
												newPassword
											})

											await auth.saveStringifiedClientToSecureStorage(await authedSdkClient.toStringified())
										})

										if (!changePasswordResult.success) {
											logger.error("settings", "changePassword failed", { error: changePasswordResult.error })
											alerts.error(changePasswordResult.error)

											return
										}

										alerts.normal(t("password_changed_successfully"))
									}
								},
								{
									icon: "shield-checkmark-outline",
									title: t("two_factor_authentication"),
									subTitle: t("two_factor_authentication_description"),
									href: "/security/twoFactor"
								},
								{
									icon: "finger-print-outline",
									title: t("biometric_authentication"),
									subTitle: t("biometric_authentication_description"),
									href: "/security/biometric"
								},
								{
									icon: "eye-off-outline",
									title: t("privacy_screen"),
									subTitle: t("privacy_screen_description"),
									rightItem: {
										type: "switch",
										value: privacyScreen,
										onValueChange: () => {
											setPrivacyScreen(prev => !prev)
										}
									}
								},
								{
									icon: "save-outline",
									iconColor: accountQuery.data.didExportMasterKeys ? undefined : (textRed500.color as string),
									title: t("export_master_keys"),
									titleClassName: accountQuery.data.didExportMasterKeys ? undefined : "text-red-500",
									subTitle: t("export_master_keys_description"),
									subTitleClassName: accountQuery.data.didExportMasterKeys ? undefined : "text-red-500",
									badge: accountQuery.data.didExportMasterKeys ? undefined : "!",
									badgeColor: accountQuery.data.didExportMasterKeys ? undefined : (textRed500.color as string),
									onPress: async () => {
										const confirmed = await confirmPrompt(
											{
												title: t("export_master_keys"),
												message: t("export_master_keys_needed_for_recovery"),
												okText: t("continue"),
												cancelText: t("cancel")
											},
											{ tag: "settings", message: "export master keys confirmation prompt failed" }
										)

										if (!confirmed) {
											return
										}

										const exportResult = await runWithLoading(async () => {
											const keys = await (await auth.getSdkClients()).authedSdkClient.exportMasterKeys()
											const exported = writeTmpFile(`${accountQuery.data.email}.masterKeys.${Date.now()}.txt`, keys)

											// The export call itself records the flag server-side.
											accountQueryPatch({
												didExportMasterKeys: true
											})

											return exported
										})

										if (!exportResult.success) {
											logger.error("settings", "exportMasterKeys failed", { error: exportResult.error })
											alerts.error(exportResult.error)

											return
										}

										const shareResult = await shareTmpFile({
											uri: exportResult.data.file.uri,
											name: exportResult.data.file.name,
											cleanup: exportResult.data.cleanup
										})

										if (!shareResult.success) {
											logger.warn("settings", "master keys file share failed", { error: shareResult.error })
											alerts.error(shareResult.error)

											return
										}
									}
								}
							]}
						/>
					</SettingsScrollView>
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default Security
