import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { SettingsLoadingView } from "@/components/ui/settingsLoadingView"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import ListEmpty from "@/components/ui/listEmpty"
import View from "@/components/ui/view"
import { Fragment } from "react"
import { router } from "@/lib/router"
import { run } from "@filen/utils"
import SettingsHeader from "@/components/ui/settingsHeader"
import useAccountQuery from "@/queries/useAccount.query"
import alerts from "@/lib/alerts"
import { buildTwoFactorButtons } from "@/features/settings/accountButtons"
import QRCode from "react-qr-code"
import Button from "@/components/ui/button"
import * as Clipboard from "expo-clipboard"
import { useTranslation } from "react-i18next"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

function TwoFactor() {
	const { t } = useTranslation()
	const isOnline = useIsOnline()

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
							buttons={buildTwoFactorButtons({ t, accountQuery, isOnline })}
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
												logger.warn("settings", "copy 2FA secret to clipboard failed", { error: result.error instanceof Error ? result.error.message : String(result.error) })
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
					</SettingsScrollView>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default TwoFactor
