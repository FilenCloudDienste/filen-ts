import { SettingsScrollView } from "@/components/ui/settingsScrollView"
import { LoadingView } from "@/components/ui/loadingView"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { Group } from "@/components/ui/settingsGroup"
import { LoadErrorEmpty } from "@/components/ui/listEmpty"
import View from "@/components/ui/view"
import { Fragment } from "react"
import { goBackIfPossible } from "@/lib/router"
import SettingsHeader from "@/components/ui/settingsHeader"
import useAccountQuery from "@/queries/useAccount.query"
import { buildTwoFactorButtons } from "@/features/settings/accountButtons"
import QRCode from "react-qr-code"
import Button from "@/components/ui/button"
import { copyToClipboard } from "@/lib/clipboard"
import { useTranslation } from "react-i18next"

function TwoFactor() {
	const { t } = useTranslation()

	const accountQuery = useAccountQuery()

	return (
		<Fragment>
			<SettingsHeader
				title={t("two_factor_authentication")}
				icon="chevron-back-outline"
				onDismiss={goBackIfPossible}
			/>
			<ScreenBody>
				{accountQuery.status === "pending" ? (
					<LoadingView />
				) : accountQuery.status === "error" ? (
					<LoadErrorEmpty
						title={t("could_not_load_account")}
						onRetry={() => accountQuery.refetch()}
					/>
				) : (
					<SettingsScrollView>
						<Group buttons={buildTwoFactorButtons({ t, accountQuery })} />
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
											await copyToClipboard(
												accountQuery.data.twoFactorKey ?? "",
												t("secret_copied_to_clipboard"),
												"settings",
												"copy 2FA secret to clipboard failed"
											)
										}}
									>
										{t("copy_secret")}
									</Button>
								</View>
							)}
					</SettingsScrollView>
				)}
			</ScreenBody>
		</Fragment>
	)
}

export default TwoFactor
