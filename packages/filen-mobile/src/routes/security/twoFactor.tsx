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
import useAccountQuery from "@/queries/useAccount.query"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"
import auth from "@/lib/auth"
import { newTmpFile } from "@/lib/tmp"
import * as Sharing from "expo-sharing"
import QRCode from "react-qr-code"
import Button from "@/components/ui/button"
import * as Clipboard from "expo-clipboard"
import { useTranslation } from "react-i18next"

const TwoFactor = memo(() => {
	const { t } = useTranslation()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<Header
				title={t("two_factor_authentication")}
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
									title: t("two_factor_authentication"),
									subTitle: t("two_factor_authentication_description"),
									rightItem: {
										type: "switch",
										value: accountQuery.data.twoFactorEnabled,
										onValueChange: async () => {
											if (accountQuery.data.twoFactorEnabled) {
												const promptResult = await run(async () => {
													return await prompts.alert({
														title: t("disable_two_factor_authentication"),
														message: t("disable_two_factor_authentication_description"),
														okText: t("continue"),
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

												const twoFactorPromptResult = await run(async () => {
													return await prompts.input({
														title: t("enter_two_factor_code"),
														message: t("enter_two_factor_code_description"),
														cancelText: t("cancel"),
														okText: t("disable"),
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

												const result = await runWithLoading(async () => {
													await (await auth.getSdkClients()).authedSdkClient.disable2fa(twoFactor)
													await accountQuery.refetch()
												})

												if (!result.success) {
													console.error(result.error)
													alerts.error(result.error)

													return
												}

												return
											}

											const twoFactorPromptResult = await run(async () => {
												return await prompts.input({
													title: t("enter_two_factor_code"),
													message: t("enter_two_factor_code_description"),
													cancelText: t("cancel"),
													okText: t("enable"),
													inputType: "secure-text"
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

											const result = await runWithLoading(async () => {
												const recoverKey = await (
													await auth.getSdkClients()
												).authedSdkClient.enable2faGetRecoveryKey(twoFactor)

												await accountQuery.refetch()

												return recoverKey
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}

											const recoverKey = result.data

											const promptResult = await run(async () => {
												return await prompts.alert({
													title: t("two_factor_recovery_key"),
													message: t("two_factor_recovery_key_description"),
													okText: t("continue"),
													cancelText: t("close")
												})
											})

											if (!promptResult.success) {
												console.error(promptResult.error)
												alerts.error(promptResult.error)

												return
											}

											const exportResult = await runWithLoading(async () => {
												const file = newTmpFile(
													`${accountQuery.data.email}.twoFactorRecoveryKey.${Date.now()}.txt`
												)

												if (file.exists) {
													file.delete()
												}

												file.write(recoverKey)

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
								}
							]}
						/>
						{!accountQuery.data.twoFactorEnabled &&
							accountQuery.data.twoFactorKey &&
							accountQuery.data.twoFactorKey.length > 0 && (
								<View className="bg-transparent items-center justify-center flex-col gap-4 mt-4">
									<View
										className="bg-white rounded-3xl items-center justify-center"
										style={{
											width: 300,
											height: 300
										}}
									>
										<QRCode
											value={accountQuery.data.twoFactorKey}
											size={256}
											style={{
												height: "auto",
												maxWidth: "100%",
												width: "100%"
											}}
											viewBox="0 0 256 256"
										/>
									</View>
									<Button
										onPress={async () => {
											const result = await run(async () => {
												return await Clipboard.setStringAsync(accountQuery.data.twoFactorKey ?? "")
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}

											alerts.normal(t("secret_copied_to_clipboard"))
										}}
									>
										{t("copy_secret")}
									</Button>
								</View>
							)}
					</GestureHandlerScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
})

export default TwoFactor
