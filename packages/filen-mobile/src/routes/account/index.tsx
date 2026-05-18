import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { router, useNavigation } from "expo-router"
import { run, formatBytes } from "@filen/utils"
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
import * as Sharing from "expo-sharing"
import * as Linking from "expo-linking"
import * as ImageManipulator from "expo-image-manipulator"
import { serialize } from "@/lib/serializer"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"

type BigIntToNumber<T> = T extends bigint
	? number
	: T extends Date
		? Date
		: T extends (infer U)[]
			? BigIntToNumber<U>[]
			: T extends object
				? {
						[K in keyof T]: BigIntToNumber<T[K]>
					}
				: T

export function convertBigInts<T>(value: T): BigIntToNumber<T> {
	if (typeof value === "bigint") {
		return Number(value) as BigIntToNumber<T>
	}

	if (value === null || value === undefined) {
		return value as BigIntToNumber<T>
	}

	if (Array.isArray(value)) {
		return value.map(convertBigInts) as BigIntToNumber<T>
	}

	// Preserve Date (and other built-ins you don't want to walk into)
	if (value instanceof Date) {
		return value as BigIntToNumber<T>
	}

	if (typeof value === "object") {
		const out: Record<string, unknown> = {}

		for (const key of Object.keys(value as object)) {
			out[key] = convertBigInts((value as Record<string, unknown>)[key])
		}

		return out as BigIntToNumber<T>
	}

	return value as BigIntToNumber<T>
}

const Account = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const navigation = useNavigation()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title="tbd_account"
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
						<PressableScale
							className="bg-background-tertiary rounded-3xl overflow-hidden flex-row gap-4 items-center p-4"
							rippleColor="transparent"
							onPress={async () => {
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
									alerts.error("tbd_no_permissions_enable_manually")

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
										throw new Error("Asset file does not exist")
									}

									if (
										!asset.mimeType ||
										!asset.mimeType.toLowerCase().startsWith("image/") ||
										!asset.fileSize ||
										!asset.fileName
									) {
										throw new Error("Selected file is not an image")
									}

									const mimeType = asset.mimeType?.toLowerCase()
									let fileToUpload = originalFile

									if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
										if (
											!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(
												FileSystem.Paths.extname(asset.fileName).toLowerCase()
											)
										) {
											throw new Error("Selected image format is not supported")
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
											throw new Error("Converted file does not exist")
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
								tbd_change_avatar
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
									title: "tbd_change_email_address",
									subTitle: accountQuery.data.email,
									onPress: async () => {
										const newEmailPromptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_change_email_address",
												message: "tbd_enter_new_email_address",
												cancelText: "tbd_cancel",
												okText: "tbd_next"
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
												title: "tbd_change_email_address",
												message: "tbd_confirm_new_email_address",
												cancelText: "tbd_cancel",
												okText: "tbd_next"
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
											alerts.error("tbd_email_addresses_do_not_match")

											return
										}

										const passwordPromptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_change_email_address",
												message: "tbd_enter_password",
												cancelText: "tbd_cancel",
												okText: "tbd_save",
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
									title: "tbd_change_nickname",
									subTitle: accountQuery.data.nickName,
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.input({
												title: "tbd_change_nickname",
												message: "tbd_enter_nickname",
												cancelText: "tbd_cancel",
												okText: "tbd_save",
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
									title: "tbd_personal_information",
									subTitle: "tbd_personal_information_description",
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
									title: "tbd_gdpr_information",
									subTitle: "tbd_gdpr_information_description",
									onPress: async () => {
										const result = await runWithLoading(async () => {
											const { authedSdkClient } = await auth.getSdkClients()

											const file = new FileSystem.File(
												FileSystem.Paths.join(FileSystem.Paths.cache, `gdpr_${accountQuery.data.email}.txt`)
											)

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
									title: "tbd_more_account_settings",
									onPress: async () => {
										const promptResult = await run(async () => {
											return await prompts.alert({
												title: "tbd_open_web_app",
												message: "tbd_open_web_app_to_change_more_settings_do_you_want_to_open_it",
												okText: "tbd_open",
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

										const canOpenResult = await run(async () => {
											return await Linking.canOpenURL("https://app.filen.io/#/settings/account")
										})

										if (!canOpenResult.success) {
											console.error(canOpenResult.error)
											alerts.error(canOpenResult.error)

											return
										}

										if (!canOpenResult.data) {
											alerts.error("tbd_cannot_open_link")

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
									title: "tbd_file_versioning",
									subTitle: "tbd_file_versioning_description",
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
									title: "tbd_login_alerts",
									subTitle: "tbd_login_alerts_description",
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
									icon: "time-outline",
									title: "tbd_logout",
									onPress: async () => {
										// TODO: logout flow
									}
								}
							]}
						/>
						<View className="bg-transparent border border-red-500 flex-col p-3 gap-2 rounded-3xl">
							<View className="bg-transparent flex-row items-center gap-2 px-2">
								<Text className="text-xs font-semibold uppercase tracking-wider">tbd_danger_zone</Text>
							</View>
							<Group
								className="bg-background-tertiary"
								buttons={[
									{
										icon: "time-outline",
										title: "tbd_delete_versioned_files",
										subTitle: formatBytes(Number(accountQuery.data.versionedStorage)),
										onPress: async () => {
											if (accountQuery.data.versionedStorage <= 0) {
												return
											}

											const promptResult = await run(async () => {
												return await prompts.alert({
													title: "tbd_delete_versioned_files",
													message: "tbd_delete_versioned_files_description_non_reversible",
													okText: "tbd_delete",
													cancelText: "tbd_cancel",
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
													title: "tbd_are_you_sure",
													message: "tbd_delete_versioned_files_description_are_you_sure",
													okText: "tbd_delete",
													cancelText: "tbd_cancel",
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
										title: "tbd_delete_all_files_and_directories",
										subTitle: formatBytes(Number(accountQuery.data.storageUsed)),
										onPress: async () => {
											if (accountQuery.data.storageUsed <= 0) {
												return
											}

											const promptResult = await run(async () => {
												return await prompts.alert({
													title: "tbd_delete_all_files_and_directories",
													message: "tbd_delete_all_files_and_directories_description_non_reversible",
													okText: "tbd_delete",
													cancelText: "tbd_cancel",
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
													title: "tbd_are_you_sure",
													message: "tbd_delete_all_files_and_directories_description_are_you_sure",
													okText: "tbd_delete",
													cancelText: "tbd_cancel",
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
										title: "tbd_request_account_deletion",
										subTitle: "tbd_request_account_deletion_description",
										onPress: async () => {
											const promptResult = await run(async () => {
												return await prompts.alert({
													title: "tbd_request_account_deletion",
													message:
														"tbd_request_account_deletion_description_non_reversible_will_send_email_first_to_confirm",
													okText: "tbd_request",
													cancelText: "tbd_cancel",
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
													title: "tbd_are_you_sure",
													message:
														"tbd_request_account_deletion_description_non_reversible_will_send_email_first_to_confirm_are_you_sure",
													okText: "tbd_request",
													cancelText: "tbd_cancel",
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
														title: "tbd_enter_two_factor_code",
														message: "tbd_enter_two_factor_code_description",
														cancelText: "tbd_cancel",
														okText: "tbd_request",
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

											alerts.normal("tbd_account_deletion_requested_follow_instructions_sent_to_email")
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
})

export default Account
