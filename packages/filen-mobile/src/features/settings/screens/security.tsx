import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { SettingsLoadingView } from "@/components/ui/settingsLoadingView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import ListEmpty from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import { Fragment } from "react"
import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import SettingsHeader from "@/components/ui/settingsHeader"
import useAccountQuery from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { newTmpFile } from "@/lib/tmp"
import { shareTmpFile } from "@/lib/share"
import useIsOnline from "@/hooks/useIsOnline"
import { usePrivacyScreenEnabled } from "@/features/settings/privacyScreen"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

function Security() {
	const { t } = useTranslation()
	const navigation = useNavigation()
	const textRed500 = useResolveClassNames("text-red-500")
	const isOnline = useIsOnline()
	const [privacyScreen, setPrivacyScreen] = usePrivacyScreenEnabled()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("security")}
				icon="close"
				onDismiss={() => {
					navigation.getParent()?.goBack()
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{accountQuery.status === "pending" ? (
					<SettingsLoadingView />
				) : accountQuery.status === "error" ? (
					<ListEmpty
						icon="warning-outline"
						title={t("could_not_load_account")}
						description={t("please_check_connection")}
						action={<Button onPress={() => accountQuery.refetch()}>{t("try_again")}</Button>}
					/>
				) : (
					<SettingsScrollView>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "key-outline",
									title: t("change_password"),
									subTitle: t("change_password_description"),
									disabled: !isOnline,
									onPress: async () => {
										const newPasswordPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_password"),
												message: t("enter_new_password"),
												cancelText: t("cancel"),
												okText: t("continue"),
												inputType: "secure-text"
											})
										})

										if (!newPasswordPromptResult.success) {
											logger.warn("settings", "change password new-password prompt failed", { error: newPasswordPromptResult.error })
											alerts.error(newPasswordPromptResult.error)

											return
										}

										if (newPasswordPromptResult.data.cancelled || newPasswordPromptResult.data.type !== "string") {
											return
										}

										const newPassword = newPasswordPromptResult.data.value

										if (newPassword.length === 0) {
											return
										}

										const confirmNewPasswordPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_password"),
												message: t("enter_confirm_new_password"),
												cancelText: t("cancel"),
												okText: t("continue"),
												inputType: "secure-text"
											})
										})

										if (!confirmNewPasswordPromptResult.success) {
											logger.warn("settings", "change password confirm-password prompt failed", { error: confirmNewPasswordPromptResult.error })
											alerts.error(confirmNewPasswordPromptResult.error)

											return
										}

										if (
											confirmNewPasswordPromptResult.data.cancelled ||
											confirmNewPasswordPromptResult.data.type !== "string"
										) {
											return
										}

										const confirmNewPassword = confirmNewPasswordPromptResult.data.value

										if (confirmNewPassword.length === 0) {
											return
										}

										if (newPassword !== confirmNewPassword) {
											alerts.error(t("passwords_do_not_match"))

											return
										}

										const currentPasswordPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_password"),
												message: t("enter_current_password"),
												cancelText: t("cancel"),
												okText: t("change"),
												inputType: "secure-text"
											})
										})

										if (!currentPasswordPromptResult.success) {
											logger.warn("settings", "change password current-password prompt failed", { error: currentPasswordPromptResult.error })
											alerts.error(currentPasswordPromptResult.error)

											return
										}

										if (
											currentPasswordPromptResult.data.cancelled ||
											currentPasswordPromptResult.data.type !== "string"
										) {
											return
										}

										const currentPassword = currentPasswordPromptResult.data.value

										if (currentPassword.length === 0) {
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
									onPress: () => {
										router.push("/security/twoFactor")
									}
								},
								{
									icon: "finger-print-outline",
									title: t("biometric_authentication"),
									subTitle: t("biometric_authentication_description"),
									onPress: () => {
										router.push("/security/biometric")
									}
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
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: t("export_master_keys"),
												message: t("export_master_keys_needed_for_recovery"),
												okText: t("continue"),
												cancelText: t("cancel")
											})
										})

										if (!promptResult.success) {
											logger.warn("settings", "export master keys confirmation prompt failed", { error: promptResult.error })
											alerts.error(promptResult.error)

											return
										}

										if (promptResult.data.cancelled) {
											return
										}

										const exportResult = await runWithLoading(async () => {
											const keys = await (await auth.getSdkClients()).authedSdkClient.exportMasterKeys()
											const file = newTmpFile(`${accountQuery.data.email}.masterKeys.${Date.now()}.txt`)

											if (file.exists) {
												file.delete()
											}

											file.write(keys)

											await accountQuery.refetch()

											return file
										})

										if (!exportResult.success) {
											logger.error("settings", "exportMasterKeys failed", { error: exportResult.error })
											alerts.error(exportResult.error)

											return
										}

										const shareResult = await shareTmpFile({
											uri: exportResult.data.uri,
											name: exportResult.data.name,
											cleanup: () => {
												if (exportResult.data.exists) {
													exportResult.data.delete()
												}
											}
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
			</SafeAreaView>
		</Fragment>
	)
}

export default Security
