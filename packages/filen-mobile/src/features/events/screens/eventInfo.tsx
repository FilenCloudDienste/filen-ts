import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import { type UserEvent } from "@filen/sdk-rs"
import { buildEventDetails } from "@/features/events/eventDetails"
import DismissStack from "@/components/dismissStack"
import { useTranslation } from "react-i18next"

const EventInfo = () => {
	const { event: eventSerialized } = useLocalSearchParams<{
		event?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const { t } = useTranslation()

	const event = (() => {
		if (!eventSerialized) {
			return null
		}

		try {
			return deserialize(eventSerialized) as UserEvent
		} catch {
			return null
		}
	})()

	if (!event) {
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
							<View
								key={title}
								className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4"
							>
								<Text
									className="text-muted-foreground shrink-0"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									{title}
								</Text>
								<View className="bg-transparent flex-1 justify-end items-center flex-row gap-2">
									<Text
										className="text-foreground flex-1 text-right"
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										{value}
									</Text>
								</View>
							</View>
						))}
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
}

export default EventInfo
