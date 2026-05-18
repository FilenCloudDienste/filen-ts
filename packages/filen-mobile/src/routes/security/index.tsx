import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
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
import * as Sharing from "expo-sharing"

const Security = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title="tbd_security"
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
								name: "close-outline",
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
									title: "tbd_change_password",
									subTitle: "tbd_change_password_description",
									onPress: async () => {
										const newPasswordPromptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_change_password",
												message: "tbd_enter_new_password",
												cancelText: "tbd_cancel",
												okText: "tbd_continue",
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
												title: "tbd_change_password",
												message: "tbd_enter_confirm_new_password",
												cancelText: "tbd_cancel",
												okText: "tbd_continue",
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
											alerts.error("tbd_passwords_do_not_match")

											return
										}

										const currentPasswordPromptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_change_password",
												message: "tbd_enter_current_password",
												cancelText: "tbd_cancel",
												okText: "tbd_change",
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
											return await (
												await auth.getSdkClients()
											).authedSdkClient.changePassword({
												currentPassword,
												newPassword
											})
										})

										if (!changePasswordResult.success) {
											console.error(changePasswordResult.error)
											alerts.error(changePasswordResult.error)

											return
										}

										alerts.normal("tbd_password_changed_successfully")

										// TODO: Logout user and force login with new password
									}
								},
								{
									icon: "time-outline",
									title: "tbd_two_factor_authentication",
									subTitle: "tbd_two_factor_authentication_description",
									onPress: () => {
										router.push("/security/twoFactor")
									}
								},
								{
									icon: "time-outline",
									title: "tbd_biometric_authentication",
									subTitle: "tbd_biometric_authentication_description",
									onPress: () => {
										router.push("/security/biometric")
									}
								},
								{
									icon: "time-outline",
									title: "tbd_export_master_keys",
									subTitle: "tbd_export_master_keys_description",
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: "tbd_export_master_keys",
												message:
													"tbd_export_master_keys_description_needed_for_password_reset_and_account_recovery",
												okText: "tbd_continue",
												cancelText: "tbd_cancel"
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

											return file
										})

										if (!exportResult.success) {
											console.error(exportResult.error)
											alerts.error(exportResult.error)

											return
										}

										const shareResult = await run(async defer => {
											defer(() => {
												if (exportResult.data.exists) {
													exportResult.data.delete()
												}
											})

											// Small delay to ensure file is fully written before sharing
											await new Promise<void>(resolve => setTimeout(resolve, 100))

											await Sharing.shareAsync(exportResult.data.uri, {
												mimeType: "text/plain",
												dialogTitle: exportResult.data.name
											})
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
})

export default Security
