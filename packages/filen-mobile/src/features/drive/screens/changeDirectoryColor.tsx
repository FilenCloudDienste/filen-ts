import Text from "@/components/ui/text"
import { ScreenBody } from "@/components/ui/safeAreaView"
import { Platform, TextInput } from "react-native"
import { useLocalSearchParams } from "expo-router"
import useDismissStack from "@/hooks/useDismissStack"
import { deserializeRouteParam } from "@/lib/serializer"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { DirectoryIcon, unwrapDirColor } from "@/components/itemIcons"
import SettingsHeader from "@/components/ui/settingsHeader"
import { Fragment, useState } from "react"
import { useResolveClassNames } from "uniwind"
import { DirColor } from "@filen/sdk-rs"
import { dirColorHex } from "@filen/shared"
import ColorPicker, { Panel1, Preview, HueSlider } from "reanimated-color-picker"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import { ScrollView } from "react-native-gesture-handler"
import { Information } from "@/features/drive/components/information"
import DismissStack from "@/components/dismissStack"
import logger from "@/lib/logger"
import useIsOnline from "@/hooks/useIsOnline"
import { driveItemDisplayName } from "@/lib/decryption"
import { useTranslation } from "react-i18next"
import { isDrivePathType } from "@/hooks/useDrivePath"
import { normalizeCustomDirColorHex, sanitizeDirColorHexInput } from "@/features/drive/utils"
import { ITEM_DETAIL_CONTENT_CLASS } from "@/features/drive/components/itemDetailLayout"

const ChangeDirectoryColor = () => {
	const { item: itemSerialized, drivePathType } = useLocalSearchParams<{
		item?: string
		drivePathType?: string
	}>()
	const textBlue500 = useResolveClassNames("text-blue-500")
	const dismiss = useDismissStack()
	const [selectedColor, setSelectedColor] = useState<string | null>(null)
	const isOnline = useIsOnline()
	const { t } = useTranslation()

	const item = deserializeRouteParam<DriveItem>(itemSerialized)

	// Lowercase: the hex field below only ever holds lowercase input
	const [hexColor, setHexColor] = useState<string>(() =>
		dirColorHex(item && item.type === "directory" ? unwrapDirColor(item.data.color) : null).toLowerCase()
	)

	const [hexInput, setHexInput] = useState<string>(hexColor)

	if (!item || item.type !== "directory") {
		return <DismissStack />
	}

	return (
		<Fragment>
			<SettingsHeader
				title={t("change_directory_color")}
				icon="close"
				onDismiss={dismiss}
				rightItems={() => {
					if (!selectedColor || !isOnline) {
						return null
					}

					return [
						{
							type: "button",
							icon: {
								name: "checkmark-outline",
								color: textBlue500.color,
								size: 20
							},
							props: {
								onPress: async () => {
									const result = await runWithLoading(async () => {
										await drive.setDirColor({
											item,
											color: DirColor.Custom.new(selectedColor)
										})
									})

									if (!result.success) {
										logger.error("drive", "set directory color failed", { error: result.error })
										alerts.error(result.error)

										return
									}

									setHexColor(selectedColor)
									setHexInput(selectedColor)
									setSelectedColor(null)
								}
							}
						}
					]
				}}
			/>
			<ScreenBody>
				<ScrollView
					contentContainerClassName={ITEM_DETAIL_CONTENT_CLASS}
					showsHorizontalScrollIndicator={true}
					showsVerticalScrollIndicator={false}
					keyboardShouldPersistTaps="handled"
					automaticallyAdjustKeyboardInsets={true}
				>
					<View className="bg-transparent items-center justify-center flex-col">
						<DirectoryIcon
							color={selectedColor ? DirColor.Custom.new(selectedColor) : DirColor.Custom.new(hexColor)}
							width={128}
							height={128}
						/>
						<Text
							className="text-lg font-bold mt-4"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{driveItemDisplayName(item)}
						</Text>
						<Text className="text-muted-foreground">{t("directory")}</Text>
					</View>
					<View className="bg-background-tertiary rounded-3xl p-4 mt-10 items-center justify-center flex-col">
						<ColorPicker
							style={{
								width: "100%"
							}}
							value={selectedColor ?? hexColor}
							onCompleteJS={e => {
								// The picker can emit "#rrggbbaa"; the first 7 chars are the color.
								const normalized = normalizeCustomDirColorHex(e.hex.slice(0, 7))

								if (!normalized) {
									return
								}

								setSelectedColor(normalized)
								setHexInput(normalized)
							}}
						>
							<Preview
								style={{
									borderTopLeftRadius: 12,
									borderTopRightRadius: 12,
									borderBottomLeftRadius: 0,
									borderBottomRightRadius: 0
								}}
							/>
							<Panel1
								style={{
									borderRadius: 0
								}}
							/>
							<HueSlider
								style={{
									borderTopLeftRadius: 0,
									borderTopRightRadius: 0,
									borderBottomLeftRadius: 12,
									borderBottomRightRadius: 12
								}}
							/>
						</ColorPicker>
						<View className="bg-transparent flex-row items-center gap-3 mt-4 w-full">
							<View
								className="h-9 w-9 rounded-lg border border-separator"
								style={{
									backgroundColor: selectedColor ?? hexColor
								}}
							/>
							<TextInput
								className="flex-1 text-foreground text-base leading-5 bg-background-secondary rounded-xl px-3 py-2"
								style={{
									fontFamily: Platform.select({
										ios: "Menlo",
										default: "monospace"
									})
								}}
								value={hexInput}
								onChangeText={text => {
									const sanitized = sanitizeDirColorHexInput(text)

									setHexInput(sanitized)

									const normalized = normalizeCustomDirColorHex(sanitized)

									if (normalized) {
										setSelectedColor(normalized)
									}
								}}
								maxLength={7}
								autoCapitalize="none"
								autoCorrect={false}
								autoComplete="off"
								importantForAutofill="no"
								accessibilityLabel={t("change_directory_color_hex_input")}
							/>
						</View>
					</View>
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

export default ChangeDirectoryColor
