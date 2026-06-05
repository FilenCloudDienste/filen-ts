import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { router, useNavigation } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useAccountQuery from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { newTmpFile } from "@/lib/tmp"
import { shareTmpFile } from "@/lib/share"
import useIsOnline from "@/hooks/useIsOnline"
import { useTranslation } from "react-i18next"

function Security() {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const textRed500 = useResolveClassNames("text-red-500")
	const isOnline = useIsOnline()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title={t("security")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={() => {
					if (Platform.OS === "android") {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									navigation.getParent()?.goBack()
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{accountQuery.status !== "success" ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : (
					<GestureHandlerScrollView
						className="bg-transparent flex-1"
						contentInsetAdjustmentBehavior="automatic"
						contentContainerClassName="px-4 gap-4"
						showsHorizontalScrollIndicator={false}
						contentContainerStyle={{
							paddingBottom: insets.bottom
						}}
					>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "time-outline",
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
											console.error(newPasswordPromptResult.error)
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
											console.error(confirmNewPasswordPromptResult.error)
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
											console.error(currentPasswordPromptResult.error)
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
											console.error(changePasswordResult.error)
											alerts.error(changePasswordResult.error)

											return
										}

										alerts.normal(t("password_changed_successfully"))
									}
								},
								{
									icon: "time-outline",
									title: t("two_factor_authentication"),
									subTitle: t("two_factor_authentication_description"),
									onPress: () => {
										router.push("/security/twoFactor")
									}
								},
								{
									icon: "time-outline",
									title: t("biometric_authentication"),
									subTitle: t("biometric_authentication_description"),
									onPress: () => {
										router.push("/security/biometric")
									}
								},
								{
									icon: "time-outline",
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
											console.error(promptResult.error)
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
											console.error(exportResult.error)
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
											console.error(shareResult.error)
											alerts.error(shareResult.error)

											return
										}
									}
								}
							]}
						/>
					</GestureHandlerScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default Security
