import DriveItemHero from "@/components/ui/driveItemHero"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { ScrollView } from "react-native"
import { useLocalSearchParams } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment } from "react"
import { useTranslation } from "react-i18next"
import DismissStack from "@/components/dismissStack"
import { Information } from "@/features/drive/components/information"
import useHttpStore from "@/stores/useHttp.store"
import { useShallow } from "zustand/shallow"
import { createMenuButtons } from "@/features/drive/components/item/menuActions"
import { driveItemDisplayName } from "@/lib/decryption"
import CannotDecryptScreen from "@/components/cannotDecryptScreen"
import type { DrivePath } from "@/hooks/useDrivePath"
import useLinkSaveable from "@/features/drive/hooks/useLinkSaveable"
import { linkSaveTarget } from "@/features/drive/linkedSave"
import { ITEM_DETAIL_CONTENT_CLASS } from "@/features/drive/components/itemDetailLayout"

// A standalone file link: a link view with no directory behind it.
const LINKED_FILE_PATH: DrivePath = {
	type: "linked",
	uuid: null
}

const LinkedFile = () => {
	const { t } = useTranslation()
	const { item: itemSerialized } = useLocalSearchParams<{
		item?: string
	}>()
	const getFileUrl = useHttpStore(useShallow(state => state.getFileUrl))
	const dismiss = useDismissStack()

	const item = deserializeRouteParam<Extract<DriveItem, { type: "file" }>>(itemSerialized)
	const linkSaveable = useLinkSaveable(item?.type === "file" ? linkSaveTarget(LINKED_FILE_PATH, item) : null)

	if (!item || item.type !== "file") {
		return <DismissStack />
	}

	if (item.data.undecryptable) {
		return <CannotDecryptScreen uuid={item.data.uuid} />
	}

	return (
		<Fragment>
			<SettingsHeader
				title={driveItemDisplayName(item)}
				icon="close"
				onDismiss={dismiss}
				rightItems={[
					{
						type: "ellipsisMenu",
						buttons: getFileUrl
							? createMenuButtons({
									item,
									drivePath: LINKED_FILE_PATH,
									isStoredOffline: false,
									linkSaveable,
									t
								})
							: []
					}
				]}
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
							linked={true}
							drivePathType="linked"
						/>
					</View>
				</ScrollView>
			</ScreenBody>
		</Fragment>
	)
}

export default LinkedFile
