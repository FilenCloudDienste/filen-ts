import { ScreenBody } from "@/components/ui/safeAreaView"
import { ScrollView } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { deserializeRouteParam } from "@/lib/serializer"
import View from "@/components/ui/view"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
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
	const { t } = useTranslation()

	const event = deserializeRouteParam<UserEvent>(eventSerialized)

	if (!event) {
		logger.warn("events", "event detail param missing or corrupt — dismissing", { paramPresent: !!eventSerialized, paramLength: eventSerialized?.length })

		return <DismissStack />
	}

	const rows = buildEventDetails(event, t)

	return (
		<Fragment>
			<SettingsHeader
				title={t("event_info")}
				icon="close"
				onDismiss={() => {
					router.back()
				}}
			/>
			<ScreenBody>
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
			</ScreenBody>
		</Fragment>
	)
}

export default EventInfo
