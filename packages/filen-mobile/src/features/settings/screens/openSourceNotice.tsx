import { Fragment } from "react"
import { Platform } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import View, { GestureHandlerScrollView } from "@/components/ui/view"
import Text from "@/components/ui/text"
import ListEmpty from "@/components/ui/listEmpty"
import { PressableScale } from "@/components/ui/pressables"
import useOpenExternalLink from "@/hooks/useOpenExternalLink"
import { findThirdPartyNotice, thirdPartyLicenseText } from "@/features/settings/thirdPartyNotices"
import logger from "@/lib/logger"

/**
 * One package's notice: its copyright line(s) and the verbatim license terms.
 *
 * The terms are shared across every package using the same license — that deduplication is what keeps
 * the payload to something shippable — so what makes this notice specific is the copyright above it.
 */
export const OpenSourceNotice = () => {
	const { t } = useTranslation()
	const openExternalLink = useOpenExternalLink("settings")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")

	// Pushed inside the Open Source stack rather than presented as its own modal, so the native back
	// arrow is the correct affordance — a close button here would dismiss the whole sheet and lose the
	// user's place in the list.
	const headerProps = {
		shadowVisible: false,
		transparent: Platform.OS === "ios",
		backVisible: true,
		backgroundColor: Platform.select({
			ios: undefined,
			default: bgBackgroundSecondary.backgroundColor as string
		})
	}

	const { name, version } = useLocalSearchParams<{
		name?: string
		version?: string
	}>()

	const notice = name !== undefined ? findThirdPartyNotice(name, version ?? "") : null
	const text = notice ? thirdPartyLicenseText(notice) : null

	if (!notice) {
		return (
			<Fragment>
				<Header
					title={t("open_source")}
					{...headerProps}
				/>
				<SafeAreaView
					className="flex-1 bg-background-secondary"
					edges={["left", "right"]}
				>
					<ListEmpty
						icon="warning-outline"
						title={t("open_source_notice_missing")}
					/>
				</SafeAreaView>
			</Fragment>
		)
	}

	return (
		<Fragment>
			<Header
				title={notice.name}
				{...headerProps}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<GestureHandlerScrollView
					contentContainerClassName="px-4 pb-40 gap-4"
					contentInsetAdjustmentBehavior="automatic"
				>
					<View className="bg-transparent gap-1">
						<Text className="text-muted-foreground text-sm leading-5">
							{notice.version ? `${notice.version} · ${notice.license}` : notice.license}
						</Text>
						{notice.repository ? (
							<PressableScale
								className="self-start"
								hitSlop={10}
								rippleColor="transparent"
								onPress={() => {
									openExternalLink(notice.repository ?? "").catch(err => {
										logger.error("settings", "failed to open a package repository", {
											error: err
										})
									})
								}}
							>
								<Text className="text-primary text-sm leading-5">{notice.repository}</Text>
							</PressableScale>
						) : null}
					</View>
					{notice.copyright.length > 0 ? (
						<View className="bg-transparent gap-1">
							{notice.copyright.map(line => (
								<Text
									key={line}
									className="text-foreground text-sm leading-5"
								>
									{line}
								</Text>
							))}
						</View>
					) : null}
					{text ? (
						<Text className="text-muted-foreground text-xs leading-5">{text}</Text>
					) : (
						// Honest about the gap rather than showing another package's copyright.
						<Text className="text-muted-foreground text-sm leading-5">{t("open_source_no_license_text")}</Text>
					)}
				</GestureHandlerScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default OpenSourceNotice
