import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/routes/tabs/more"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment, memo } from "react"
import { router } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import { Platform, ActivityIndicator } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import { useSecureStore } from "@/lib/secureStore"
import useLocalAuthenticationQuery from "@/queries/useLocalAuthentication.query"
import Text from "@/components/ui/text"
import { actionSheet } from "@/providers/actionSheet.provider"
import fileProvider, { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/lib/fileProvider"

export type Biometric =
	| {
			enabled: false
	  }
	| {
			enabled: true
			fallback: string
			lockAfter: number
			lockedUntil: number
			lockedMultiplier: number
			pinOnly: boolean
	  }

const BiometricComponent = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [biometric, setBiometric] = useSecureStore<Biometric>("biometric", {
		enabled: false
	})
	const [fileProviderEnabled, setFileProviderEnabled] = useSecureStore<boolean>(
		FILE_PROVIDER_ENABLED_SECURE_STORE_KEY,
		false
	)
	const localAuthenticationQuery = useLocalAuthenticationQuery()

	return (
		<Fragment>
			<Header
				title="tbd_biometric_authentication"
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
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									if (router.canGoBack()) {
										router.back()
									}
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
				{localAuthenticationQuery.status === "success" ? (
					localAuthenticationQuery.data.hasHardware && localAuthenticationQuery.data.isEnrolled ? (
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
										title: "tbd_biometric_authentication",
										subTitle: "tbd_biometric_authentication_description",
										rightItem: {
											type: "switch",
											value: biometric.enabled,
											onValueChange: async () => {
												if (biometric.enabled) {
													setBiometric({
														enabled: false
													})

													return
												}

												// If the file/documents provider is on, warn the user
												// that enabling biometric will disable it. The native
												// provider extensions read auth.json directly and
												// bypass the JS biometric gate, so having both on at
												// the same time creates a false sense of security.
												if (fileProviderEnabled) {
													const confirmProviderDisableResult = await run(async () => {
														return await prompts.alert({
															title: "tbd_biometric_disables_file_provider_title",
															message: "tbd_biometric_disables_file_provider_message",
															okText: "tbd_continue",
															cancelText: "tbd_cancel"
														})
													})

													if (!confirmProviderDisableResult.success) {
														console.error(confirmProviderDisableResult.error)
														alerts.error(confirmProviderDisableResult.error)

														return
													}

													if (confirmProviderDisableResult.data.cancelled) {
														return
													}

													const disableProviderResult = await run(async () => {
														await fileProvider.disable()
													})

													if (!disableProviderResult.success) {
														console.error(disableProviderResult.error)
														alerts.error(disableProviderResult.error)

														return
													}

													setFileProviderEnabled(false)
												}

												const fallbackPromptResult = await run(async () => {
													return await prompts.input({
														title: "tbd_fallback_password",
														message: "tbd_enter_fallback_password",
														cancelText: "tbd_cancel",
														okText: "tbd_continue",
														inputType: "secure-text"
													})
												})

												if (!fallbackPromptResult.success) {
													console.error(fallbackPromptResult.error)
													alerts.error(fallbackPromptResult.error)

													return
												}

												if (fallbackPromptResult.data.cancelled || fallbackPromptResult.data.type !== "string") {
													return
												}

												const fallbackPassword = fallbackPromptResult.data.value

												if (fallbackPassword.length === 0) {
													return
												}

												const confirmFallbackPasswordPromptResult = await run(async () => {
													return await prompts.input({
														title: "tbd_fallback_password",
														message: "tbd_enter_confirm_fallback_password",
														cancelText: "tbd_cancel",
														okText: "tbd_save",
														inputType: "secure-text"
													})
												})

												if (!confirmFallbackPasswordPromptResult.success) {
													console.error(confirmFallbackPasswordPromptResult.error)
													alerts.error(confirmFallbackPasswordPromptResult.error)

													return
												}

												if (
													confirmFallbackPasswordPromptResult.data.cancelled ||
													confirmFallbackPasswordPromptResult.data.type !== "string"
												) {
													return
												}

												const confirmFallbackPassword = confirmFallbackPasswordPromptResult.data.value

												if (confirmFallbackPassword.length === 0) {
													return
												}

												if (fallbackPassword !== confirmFallbackPassword) {
													alerts.error("tbd_fallback_passwords_do_not_match")

													return
												}

												setBiometric({
													lockAfter: 0,
													enabled: true,
													fallback: fallbackPassword,
													lockedUntil: 0,
													pinOnly: false,
													lockedMultiplier: 1
												})
											}
										}
									}
								]}
							/>
							{biometric.enabled && (
								<Group
									className="bg-background-tertiary"
									buttons={[
										{
											icon: "time-outline",
											title: "tbd_pin_only",
											subTitle: "tbd_pin_only_description",
											rightItem: {
												type: "switch",
												value: biometric.pinOnly,
												onValueChange: () => {
													setBiometric(prev => {
														if (!prev.enabled) {
															return prev
														}

														return {
															...prev,
															pinOnly: !prev.pinOnly
														} satisfies Biometric
													})
												}
											}
										},
										{
											icon: "time-outline",
											title: "tbd_lock_app_after",
											subTitle:
												biometric.lockAfter === 0
													? "tbd_immediately"
													: biometric.lockAfter === 60
														? "tbd_one_minute"
														: biometric.lockAfter === 60 * 5
															? "tbd_five_minutes"
															: biometric.lockAfter === 60 * 15
																? "tbd_fifteen_minutes"
																: biometric.lockAfter === 60 * 30
																	? "tbd_thirty_minutes"
																	: biometric.lockAfter === 60 * 60
																		? "tbd_one_hour"
																		: "tbd_lock_app_after_description",
											onPress: () => {
												actionSheet.show({
													buttons: [
														...[
															{
																title: "tbd_immediately",
																seconds: 0
															},
															{
																title: "tbd_one_minute",
																seconds: 60
															},
															{
																title: "tbd_five_minutes",
																seconds: 60 * 5
															},
															{
																title: "tbd_fifteen_minutes",
																seconds: 60 * 15
															},
															{
																title: "tbd_thirty_minutes",
																seconds: 60 * 30
															},
															{
																title: "tbd_one_hour",
																seconds: 60 * 60
															}
														].map(option => ({
															title: option.title,
															onPress: () => {
																setBiometric(prev => {
																	if (!prev.enabled) {
																		return prev
																	}

																	return {
																		...prev,
																		lockAfter: option.seconds
																	} satisfies Biometric
																})
															}
														})),
														{
															title: "tbd_close",
															cancel: true
														}
													]
												})
											}
										}
									]}
								/>
							)}
						</GestureHandlerScrollView>
					) : (
						<View className="flex-1 bg-transparent items-center justify-center px-10">
							<Text className="text-center">tbd_biometric_auth_not_supported_on_device_no_hardware_or_not_enrolled</Text>
						</View>
					)
				) : (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default BiometricComponent
