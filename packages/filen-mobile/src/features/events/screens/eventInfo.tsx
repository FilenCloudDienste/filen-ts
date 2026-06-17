import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserializeRouteParam } from "@/lib/serializer"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import { type UserEvent } from "@filen/sdk-rs"
import { buildEventDetails } from "@/features/events/eventDetails"
import DismissStack from "@/components/dismissStack"
import { useTranslation } from "react-i18next"
import DetailRow from "@/components/ui/detailRow"
import logger from "@/lib/logger"

const EventInfo = () => {
	const { event: eventSerialized } = useLocalSearchParams<{
		event?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const { t } = useTranslation()

	const event = deserializeRouteParam<UserEvent>(eventSerialized)

	if (!event) {
		logger.warn("events", "event detail param missing or corrupt — dismissing", { paramPresent: !!eventSerialized, paramLength: eventSerialized?.length })

		return <DismissStack />
	}

	const rows = buildEventDetails(event, t)

	return (
		<Fragment>
			<Header
				title={t("event_info")}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.back()
								}
							}
						}
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<ScrollView
					contentContainerClassName="bg-transparent px-4 flex-col pb-40"
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
					contentInsetAdjustmentBehavior="automatic"
				>
					<View className="bg-transparent flex-col gap-2">
						{rows.map(({ title, value }) => (
							<DetailRow
								key={title}
								title={title}
								value={value}
							/>
						))}
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default EventInfo
