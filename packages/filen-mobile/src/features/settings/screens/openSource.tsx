import { useState, Fragment, useCallback } from "react"
import { Platform } from "react-native"
import { useTranslation } from "react-i18next"
import { useResolveClassNames } from "uniwind"
import Header from "@/components/ui/header"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import Text from "@/components/ui/text"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import { PressableScale } from "@/components/ui/pressables"
import Ionicons from "@expo/vector-icons/Ionicons"
import { router } from "@/lib/router"
import { THIRD_PARTY_NOTICES, type ThirdPartyNotice } from "@/features/settings/thirdPartyNotices"

const Row = ({ notice }: { notice: ThirdPartyNotice }) => {
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	return (
		<PressableScale
			className="flex-row items-center gap-3 px-4 py-3"
			rippleColor="transparent"
			onPress={() => {
				router.push({
					pathname: "/openSourceNotice",
					params: {
						// Name and version together are the only stable identity: the same package can
						// legitimately appear at two versions, and the index would shift on every regeneration.
						name: notice.name,
						version: notice.version
					}
				})
			}}
		>
			<View className="flex-1 bg-transparent">
				<Text
					numberOfLines={1}
					className="text-foreground text-base"
				>
					{notice.name}
				</Text>
				<Text
					numberOfLines={1}
					className="text-muted-foreground text-sm leading-5"
				>
					{notice.version ? `${notice.version} · ${notice.license}` : notice.license}
				</Text>
			</View>
			<Ionicons
				name="chevron-forward-outline"
				size={18}
				color={textMutedForeground.color}
			/>
		</PressableScale>
	)
}

/**
 * Attribution for everything compiled or bundled into the app.
 *
 * The obligation is real rather than courtesy: MIT, BSD and Apache-2.0 all require the license text
 * and the copyright notice to travel with the distribution, and the app ships both an npm dependency
 * tree and a Rust SDK compiled from crates.io. The payload behind this screen is generated from the
 * lockfiles — see scripts/generateThirdPartyNotices.ts — so it cannot drift from what is installed by
 * being edited by hand.
 */
export const OpenSource = () => {
	const { t } = useTranslation()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")

	const query = searchQuery.trim().toLowerCase()

	const visible =
		query.length === 0
			? THIRD_PARTY_NOTICES
			: THIRD_PARTY_NOTICES.filter(
					notice => notice.name.toLowerCase().includes(query) || notice.license.toLowerCase().includes(query)
				)

	const renderItem = useCallback((info: ListRenderItemInfo<ThirdPartyNotice>) => <Row notice={info.item} />, [])

	const keyExtractor = useCallback((notice: ThirdPartyNotice) => `${notice.ecosystem}:${notice.name}@${notice.version}`, [])

	return (
		<Fragment>
			<Header
				title={t("open_source")}
				shadowVisible={false}
				transparent={Platform.OS === "ios"}
				searchBarOptions={{
					placement: "integratedButton",
					placeholder: t("open_source_search"),
					onChangeText: e => setSearchQuery(e.nativeEvent.text),
					onCancelButtonPress: () => setSearchQuery(""),
					onClose: () => setSearchQuery(""),
					onOpen: () => setSearchQuery(""),
					allowToolbarIntegration: false,
					headerIconColor: textForeground.color,
					textColor: textForeground.color,
					barTintColor: "transparent",
					tintColor: textForeground.color,
					hintTextColor: textMutedForeground.color,
					shouldShowHintSearchIcon: true,
					hideNavigationBar: false,
					hideWhenScrolling: false,
					inputType: "text"
				}}
			/>
			<SafeAreaView edges={["left", "right"]}>
				<VirtualList
					className="flex-1"
					data={visible}
					renderItem={renderItem}
					keyExtractor={keyExtractor}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName="pb-40"
					emptyComponent={() => (
						<ListEmpty
							icon="search-outline"
							title={t("no_results")}
							description={t("no_results_description")}
						/>
					)}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default OpenSource
