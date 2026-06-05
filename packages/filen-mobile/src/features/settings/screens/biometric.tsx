import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
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
import fileProvider, { FILE_PROVIDER_ENABLED_SECURE_STORE_KEY } from "@/features/settings/fileProvider"
import { useTranslation } from "react-i18next"

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

function BiometricComponent() {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()
	const [biometric, setBiometric] = useSecureStore<Biometric>("biometric", {
		enabled: false
	})
	const [fileProviderEnabled, setFileProviderEnabled] = useSecureStore<boolean>(FILE_PROVIDER_ENABLED_SECURE_STORE_KEY, false)
	const localAuthenticationQuery = useLocalAuthenticationQuery()

	return (
		<Fragment>
			<Header
				title={t("biometric_authentication")}
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
										title: t("biometric_authentication"),
										subTitle: t("biometric_authentication_description"),
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
															title: t("biometric_disables_file_provider_title"),
															message: t("biometric_disables_file_provider_message"),
															okText: t("continue"),
															cancelText: t("cancel")
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
														title: t("fallback_password"),
														message: t("enter_fallback_password"),
														cancelText: t("cancel"),
														okText: t("continue"),
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
														title: t("fallback_password"),
														message: t("enter_confirm_fallback_password"),
														cancelText: t("cancel"),
														okText: t("save"),
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
													alerts.error(t("fallback_passwords_do_not_match"))

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
											title: t("pin_only"),
											subTitle: t("pin_only_description"),
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
											title: t("lock_app_after"),
											subTitle:
												biometric.lockAfter === 0
													? t("immediately")
													: biometric.lockAfter === 60
														? t("one_minute")
														: biometric.lockAfter === 60 * 5
															? t("five_minutes")
															: biometric.lockAfter === 60 * 15
																? t("fifteen_minutes")
																: biometric.lockAfter === 60 * 30
																	? t("thirty_minutes")
																	: biometric.lockAfter === 60 * 60
																		? t("one_hour")
																		: t("lock_app_after_description"),
											onPress: () => {
												actionSheet.show({
													buttons: [
														...[
															{
																title: t("immediately"),
																seconds: 0
															},
															{
																title: t("one_minute"),
																seconds: 60
															},
															{
																title: t("five_minutes"),
																seconds: 60 * 5
															},
															{
																title: t("fifteen_minutes"),
																seconds: 60 * 15
															},
															{
																title: t("thirty_minutes"),
																seconds: 60 * 30
															},
															{
																title: t("one_hour"),
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
															title: t("close"),
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
							<Text className="text-center">{t("biometric_not_supported")}</Text>
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
}

export default BiometricComponent
