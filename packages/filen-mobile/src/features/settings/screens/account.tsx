import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { router, useNavigation } from "expo-router"
import { run, formatBytes, cn } from "@filen/utils"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import Text from "@/components/ui/text"
import useAccountQuery from "@/queries/useAccount.query"
import { PressableScale } from "@/components/ui/pressables"
import Avatar from "@/components/ui/avatar"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import * as ImagePicker from "expo-image-picker"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import * as FileSystem from "expo-file-system"
import { newTmpFile } from "@/lib/tmp"
import * as Sharing from "expo-sharing"
import * as Linking from "expo-linking"
import * as ImageManipulator from "expo-image-manipulator"
import { serialize } from "@/lib/serializer"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import useIsOnline from "@/hooks/useIsOnline"
import { useTranslation } from "react-i18next"
import i18n from "@/lib/i18n"
import { convertBigInts } from "@/lib/utils"

function Account() {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()
	const textRed500 = useResolveClassNames("text-red-500")
	const isOnline = useIsOnline()
	const { t } = useTranslation()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title={t("account")}
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
						<PressableScale
							className={cn(
								"bg-background-tertiary rounded-3xl overflow-hidden flex-row gap-4 items-center p-4",
								!isOnline && "opacity-50"
							)}
							rippleColor="transparent"
							onPress={async () => {
								if (!isOnline) {
									return
								}

								const permissionsResult = await run(async () => {
									return await hasAllNeededMediaPermissions({
										shouldRequest: true
									})
								})

								if (!permissionsResult.success) {
									console.error(permissionsResult.error)
									alerts.error(permissionsResult.error)

									return
								}

								if (!permissionsResult.data) {
									alerts.error(t("no_permissions_enable_manually"))

									return
								}

								const imagePickerResult = await run(async () => {
									return await ImagePicker.launchImageLibraryAsync({
										mediaTypes: ["images"],
										exif: false,
										base64: false,
										quality: 1,
										allowsMultipleSelection: false,
										allowsEditing: true,
										presentationStyle: ImagePicker.UIImagePickerPresentationStyle.PAGE_SHEET,
										shouldDownloadFromNetwork: true
									})
								})

								if (!imagePickerResult.success) {
									console.error(imagePickerResult.error)
									alerts.error(imagePickerResult.error)

									return
								}

								if (imagePickerResult.data.canceled) {
									return
								}

								const asset = imagePickerResult.data.assets[0]

								if (!asset) {
									return
								}

								const result = await runWithLoading(async defer => {
									const originalFile = new FileSystem.File(asset.uri)

									defer(() => {
										if (originalFile.exists) {
											originalFile.delete()
										}
									})

									if (!originalFile.exists) {
										throw new Error(i18n.t("avatar_upload_failed"))
									}

									if (
										!asset.mimeType ||
										!asset.mimeType.toLowerCase().startsWith("image/") ||
										!asset.fileSize ||
										!asset.fileName
									) {
										throw new Error(i18n.t("avatar_not_an_image"))
									}

									const mimeType = asset.mimeType?.toLowerCase()
									let fileToUpload = originalFile

									if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
										if (
											!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(
												FileSystem.Paths.extname(asset.fileName).toLowerCase()
											)
										) {
											throw new Error(i18n.t("avatar_unsupported_format"))
										}

										// Hold the Context in a local binding across the await. expo-image-manipulator's
										// Context overrides sharedObjectDidRelease to cancel its underlying coroutine task;
										// if the chained intermediate ref were eligible for Hermes GC during renderAsync,
										// the native task would be cancelled and renderAsync would reject with
										// JobCancellationException.
										const context = ImageManipulator.ImageManipulator.manipulate(asset.uri)
										const manipulated = await context.renderAsync()
										const saved = await manipulated.saveAsync({
											format: ImageManipulator.SaveFormat.JPEG,
											base64: false
										})

										const convertedFile = new FileSystem.File(saved.uri)

										defer(() => {
											if (convertedFile.exists) {
												convertedFile.delete()
											}
										})

										if (!convertedFile.exists) {
											throw new Error(i18n.t("avatar_upload_failed"))
										}

										fileToUpload = convertedFile
									}

									const { authedSdkClient } = await auth.getSdkClients()

									await authedSdkClient.uploadAvatar(await fileToUpload.arrayBuffer())
									await accountQuery.refetch()
								})

								if (!result.success) {
									console.error(result.error)
									alerts.error(result.error)

									return
								}
							}}
						>
							<Avatar
								size={22}
								source={accountQuery.data.avatarUrl}
							/>
							<Text
								numberOfLines={1}
								ellipsizeMode="middle"
								className="text-sm flex-1"
							>
								{t("change_avatar")}
							</Text>
							<Ionicons
								name="chevron-forward-outline"
								size={20}
								color={textMutedForeground.color}
							/>
						</PressableScale>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "time-outline",
									title: t("change_email_address"),
									subTitle: accountQuery.data.email,
									disabled: !isOnline,
									onPress: async () => {
										const newEmailPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_email_address"),
												message: t("enter_new_email_address"),
												cancelText: t("cancel"),
												okText: t("next")
											})
										})

										if (!newEmailPromptResult.success) {
											console.error(newEmailPromptResult.error)
											alerts.error(newEmailPromptResult.error)

											return
										}

										if (newEmailPromptResult.data.cancelled || newEmailPromptResult.data.type !== "string") {
											return
										}

										const newEmail = newEmailPromptResult.data.value.trim()

										if (newEmail.length === 0) {
											return
										}

										const confirmNewEmailPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_email_address"),
												message: t("confirm_new_email_address"),
												cancelText: t("cancel"),
												okText: t("next")
											})
										})

										if (!confirmNewEmailPromptResult.success) {
											console.error(confirmNewEmailPromptResult.error)
											alerts.error(confirmNewEmailPromptResult.error)

											return
										}

										if (
											confirmNewEmailPromptResult.data.cancelled ||
											confirmNewEmailPromptResult.data.type !== "string"
										) {
											return
										}

										const confirmNewEmail = confirmNewEmailPromptResult.data.value.trim()

										if (confirmNewEmail.length === 0) {
											return
										}

										if (newEmail !== confirmNewEmail) {
											alerts.error(t("email_addresses_do_not_match"))

											return
										}

										const passwordPromptResult = await run(async () => {
											return await prompts.input({
												title: t("change_email_address"),
												message: t("enter_password"),
												cancelText: t("cancel"),
												okText: t("save"),
												inputType: "secure-text"
											})
										})

										if (!passwordPromptResult.success) {
											console.error(passwordPromptResult.error)
											alerts.error(passwordPromptResult.error)

											return
										}

										if (passwordPromptResult.data.cancelled || passwordPromptResult.data.type !== "string") {
											return
										}

										const password = passwordPromptResult.data.value

										if (password.length === 0) {
											return
										}

										const result = await runWithLoading(async () => {
											const { authedSdkClient } = await auth.getSdkClients()

											await authedSdkClient.changeEmail(password, newEmail)
											await accountQuery.refetch()
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									icon: "time-outline",
									title: t("change_nickname"),
									subTitle: accountQuery.data.nickName,
									disabled: !isOnline,
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.input({
												title: t("change_nickname"),
												message: t("enter_nickname"),
												cancelText: t("cancel"),
												okText: t("save"),
												placeholder: accountQuery.data.nickName
											})
										})

										if (!promptResult.success) {
											console.error(promptResult.error)
											alerts.error(promptResult.error)

											return
										}

										if (promptResult.data.cancelled || promptResult.data.type !== "string") {
											return
										}

										const newNickname = promptResult.data.value.trim()

										if (newNickname.length === 0) {
											return
										}

										const result = await runWithLoading(async () => {
											const { authedSdkClient } = await auth.getSdkClients()

											await authedSdkClient.setNickname(newNickname)
											await accountQuery.refetch()
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								},
								{
									icon: "time-outline",
									title: t("personal_information"),
									subTitle: t("personal_information_description"),
									onPress: () => {
										router.push({
											pathname: "/account/personal",
											params: {
												personal: serialize(accountQuery.data.personal)
											}
										})
									}
								},
								{
									icon: "time-outline",
									title: t("gdpr_information"),
									subTitle: t("gdpr_information_description"),
									disabled: !isOnline,
									onPress: async () => {
										const result = await runWithLoading(async () => {
											const { authedSdkClient } = await auth.getSdkClients()

											const file = newTmpFile(`gdpr_${accountQuery.data.email}.txt`)

											file.write(JSON.stringify(convertBigInts(await authedSdkClient.getGdprInfo()), null, 4))

											return file
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}

										const shareResult = await run(async defer => {
											defer(() => {
												if (result.data.exists) {
													result.data.delete()
												}
											})

											// Small delay to ensure file is fully written before sharing
											await new Promise<void>(resolve => setTimeout(resolve, 100))

											await Sharing.shareAsync(result.data.uri, {
												mimeType: "text/plain",
												dialogTitle: result.data.name
											})
										})

										if (!shareResult.success) {
											console.error(shareResult.error)
											alerts.error(shareResult.error)

											return
										}
									}
								},
								{
									icon: "time-outline",
									title: t("more_account_settings"),
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: t("open_web_app"),
												message: t("open_web_app_to_change_more_settings_do_you_want_to_open_it"),
												okText: t("open"),
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

										const canOpenResult = await run(async () => {
											return await Linking.canOpenURL("https://app.filen.io/#/settings/account")
										})

										if (!canOpenResult.success) {
											console.error(canOpenResult.error)
											alerts.error(canOpenResult.error)

											return
										}

										if (!canOpenResult.data) {
											alerts.error(t("cannot_open_link"))

											return
										}

										const openResult = await run(async () => {
											return await Linking.openURL("https://app.filen.io/#/settings/account")
										})

										if (!openResult.success) {
											console.error(openResult.error)
											alerts.error(openResult.error)

											return
										}
									}
								}
							]}
						/>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "time-outline",
									title: t("file_versioning"),
									subTitle: t("file_versioning_description"),
									disabled: !isOnline,
									rightItem: {
										type: "switch",
										value: accountQuery.data.versioningEnabled,
										onValueChange: async () => {
											const result = await runWithLoading(async () => {
												const { authedSdkClient } = await auth.getSdkClients()

												await authedSdkClient.setVersioningEnabled(!accountQuery.data.versioningEnabled)
												await accountQuery.refetch()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									}
								},
								{
									icon: "time-outline",
									title: t("login_alerts"),
									subTitle: t("login_alerts_description"),
									disabled: !isOnline,
									rightItem: {
										type: "switch",
										value: accountQuery.data.loginAlertsEnabled,
										onValueChange: async () => {
											const result = await runWithLoading(async () => {
												const { authedSdkClient } = await auth.getSdkClients()

												await authedSdkClient.setLoginAlertsEnabled(!accountQuery.data.loginAlertsEnabled)
												await accountQuery.refetch()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									}
								}
							]}
						/>
						<Group
							className="bg-background-tertiary"
							buttons={[
								{
									icon: "log-out-outline",
									title: t("logout"),
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: t("logout"),
												message: t("logout_confirm_wipes_local_data"),
												okText: t("logout"),
												cancelText: t("cancel"),
												destructive: true
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

										const result = await runWithLoading(async () => {
											await auth.logout()
										})

										if (!result.success) {
											console.error(result.error)
											alerts.error(result.error)

											return
										}
									}
								}
							]}
						/>
						<View className="bg-transparent gap-2">
							<View className="bg-transparent flex-row items-center gap-2 px-2">
								<Text className="text-xs font-semibold uppercase tracking-wider text-red-500">{t("danger_zone")}</Text>
							</View>
							<Group
								className="bg-background-tertiary"
								buttons={[
									{
										icon: "time-outline",
										iconColor: textRed500.color as string,
										title: t("delete_versioned_files"),
										titleClassName: "text-red-500",
										subTitle: formatBytes(Number(accountQuery.data.versionedStorage)),
										disabled: !isOnline,
										onPress: async () => {
											if (accountQuery.data.versionedStorage <= 0) {
												return
											}

											const promptResult = await run(async () => {
												return await prompts.alert({
													title: t("delete_versioned_files"),
													message: t("delete_versioned_files_description_non_reversible"),
													okText: t("delete"),
													cancelText: t("cancel"),
													destructive: true
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

											const confirmPromptResult = await run(async () => {
												return await prompts.alert({
													title: t("are_you_sure"),
													message: t("delete_versioned_files_description_are_you_sure"),
													okText: t("delete"),
													cancelText: t("cancel"),
													destructive: true
												})
											})

											if (!confirmPromptResult.success) {
												console.error(confirmPromptResult.error)
												alerts.error(confirmPromptResult.error)

												return
											}

											if (confirmPromptResult.data.cancelled) {
												return
											}

											const result = await runWithLoading(async () => {
												const { authedSdkClient } = await auth.getSdkClients()

												await authedSdkClient.deleteAllVersions()
												await accountQuery.refetch()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									},
									{
										icon: "time-outline",
										iconColor: textRed500.color as string,
										title: t("delete_all_files_and_directories"),
										titleClassName: "text-red-500",
										subTitle: formatBytes(Number(accountQuery.data.storageUsed)),
										disabled: !isOnline,
										onPress: async () => {
											if (accountQuery.data.storageUsed <= 0) {
												return
											}

											const promptResult = await run(async () => {
												return await prompts.alert({
													title: t("delete_all_files_and_directories"),
													message: t("delete_all_files_and_directories_description_non_reversible"),
													okText: t("delete"),
													cancelText: t("cancel"),
													destructive: true
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

											const confirmPromptResult = await run(async () => {
												return await prompts.alert({
													title: t("are_you_sure"),
													message: t("delete_all_files_and_directories_description_are_you_sure"),
													okText: t("delete"),
													cancelText: t("cancel"),
													destructive: true
												})
											})

											if (!confirmPromptResult.success) {
												console.error(confirmPromptResult.error)
												alerts.error(confirmPromptResult.error)

												return
											}

											if (confirmPromptResult.data.cancelled) {
												return
											}

											const result = await runWithLoading(async () => {
												const { authedSdkClient } = await auth.getSdkClients()

												await authedSdkClient.deleteAllItems()
												await accountQuery.refetch()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									},
									{
										icon: "time-outline",
										iconColor: textRed500.color as string,
										title: t("request_account_deletion"),
										titleClassName: "text-red-500",
										subTitle: t("request_account_deletion_description"),
										disabled: !isOnline,
										onPress: async () => {
											const promptResult = await run(async () => {
												return await prompts.alert({
													title: t("request_account_deletion"),
													message: t("request_account_deletion_description_non_reversible_will_send_email_first_to_confirm"),
													okText: t("request"),
													cancelText: t("cancel"),
													destructive: true
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

											const confirmPromptResult = await run(async () => {
												return await prompts.alert({
													title: t("are_you_sure"),
													message: t(
														"request_account_deletion_description_non_reversible_will_send_email_first_to_confirm_are_you_sure"
													),
													okText: t("request"),
													cancelText: t("cancel"),
													destructive: true
												})
											})

											if (!confirmPromptResult.success) {
												console.error(confirmPromptResult.error)
												alerts.error(confirmPromptResult.error)

												return
											}

											if (confirmPromptResult.data.cancelled) {
												return
											}

											let twoFactorCode: string | undefined = undefined

											if (accountQuery.data.twoFactorEnabled) {
												const twoFactorPromptResult = await run(async () => {
													return await prompts.input({
														title: t("enter_two_factor_code"),
														message: t("enter_two_factor_code_description_confirm"),
														cancelText: t("cancel"),
														okText: t("request"),
														inputType: "secure-text",
														destructive: true
													})
												})

												if (!twoFactorPromptResult.success) {
													console.error(twoFactorPromptResult.error)
													alerts.error(twoFactorPromptResult.error)

													return
												}

												if (twoFactorPromptResult.data.cancelled || twoFactorPromptResult.data.type !== "string") {
													return
												}

												const twoFactor = twoFactorPromptResult.data.value

												if (twoFactor.length === 0) {
													return
												}

												twoFactorCode = twoFactor
											}

											const result = await runWithLoading(async () => {
												const { authedSdkClient } = await auth.getSdkClients()

												await authedSdkClient.deleteAccount(twoFactorCode)
												await accountQuery.refetch()
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}

											alerts.normal(t("account_deletion_requested_follow_instructions_sent_to_email"))
										}
									}
								]}
							/>
						</View>
					</GestureHandlerScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default Account
