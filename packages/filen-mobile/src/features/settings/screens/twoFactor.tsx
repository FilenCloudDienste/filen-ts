import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import { Fragment } from "react"
import { router } from "expo-router"
import { run } from "@filen/utils"
import { useResolveClassNames } from "uniwind"
import SettingsHeader from "@/components/ui/settingsHeader"
import { ActivityIndicator } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useAccountQuery from "@/queries/useAccount.query"
import alerts from "@/lib/alerts"
import { buildTwoFactorButtons } from "@/features/settings/accountButtons"
import QRCode from "react-qr-code"
import Button from "@/components/ui/button"
import * as Clipboard from "expo-clipboard"
import { useTranslation } from "react-i18next"

function TwoFactor() {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("two_factor_authentication")}
				icon="chevron-back-outline"
				onDismiss={() => {
					if (router.canGoBack()) {
						router.back()
					}
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
							buttons={buildTwoFactorButtons({ t, accountQuery })}
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
}

export default TwoFactor
