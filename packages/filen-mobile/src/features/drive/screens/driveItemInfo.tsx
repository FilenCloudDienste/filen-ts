import { ScreenBody } from "@/components/ui/safeAreaView"
import { ScrollView } from "react-native"
import { useLocalSearchParams } from "expo-router"
import { router } from "@/lib/router"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
import { Information } from "@/features/drive/components/information"
import DismissStack from "@/components/dismissStack"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import { useTranslation } from "react-i18next"
import DriveItemHero from "@/components/ui/driveItemHero"
import { isDrivePathType } from "@/hooks/useDrivePath"
import { ITEM_DETAIL_CONTENT_CLASS } from "@/features/drive/components/itemDetailLayout"

const DriveItemInfo = () => {
	const { item: itemSerialized, drivePathType } = useLocalSearchParams<{
		item?: string
		drivePathType?: string
	}>()
	const { t } = useTranslation()

	const item = deserializeRouteParam<DriveItem>(itemSerialized)

	if (!item) {
		return <DismissStack />
	}

	// Deep-link defensive guard: if the user opens info for an undecryptable
	// item, show the cannot-decrypt screen instead of an info sheet that would
	// surface uuid-only fallbacks for every metadata row.
	if (item.data.undecryptable) {
		return <CannotDecryptScreen uuid={item.data.uuid} />
	}

	return (
		<Fragment>
			<SettingsHeader
				title={t("item_info")}
				icon="close"
				onDismiss={() => {
					router.back()
				}}
			/>
			<ScreenBody>
				<ScrollView
					contentContainerClassName={ITEM_DETAIL_CONTENT_CLASS}
					showsHorizontalScrollIndicator={true}
					showsVerticalScrollIndicator={false}
				>
					<DriveItemHero item={item} />
					<View className="bg-transparent mt-10">
						<Information
							item={item}
							drivePathType={isDrivePathType(drivePathType) ? drivePathType : undefined}
						/>
					</View>
				</ScrollView>
			</ScreenBody>
		</Fragment>
	)
}

export default DriveItemInfo
