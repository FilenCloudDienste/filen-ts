import { memo, useMemo } from "@/lib/memo"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform } from "react-native"
import { useLocalSearchParams, Redirect, router } from "expo-router"
import { unpack } from "@/lib/msgpack"
import { Buffer } from "react-native-quick-crypto"
import type { DriveItem } from "@/types"
import View from "@/components/ui/view"
import { DirectoryIcon, unwrapDirColor, directoryColorToHex } from "@/components/itemIcons"
import Header from "@/components/ui/header"
import { Fragment, useState } from "react"
import { useResolveClassNames } from "uniwind"
import { cn } from "@filen/utils"
import { DirColor } from "@filen/sdk-rs"
import ColorPicker, { Panel1, Preview, HueSlider } from "reanimated-color-picker"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/lib/drive"
import { ScrollView } from "react-native-gesture-handler"
import { Information } from "@/routes/driveItemInfo"
import { useStringifiedClient } from "@/lib/auth"

const ChangeDirectoryColor = memo(() => {
	const { itemPackedBase64 } = useLocalSearchParams<{
		itemPackedBase64?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const [selectedColor, setSelectedColor] = useState<string | null>(null)
	const stringifiedClient = useStringifiedClient()

	const item = useMemo(() => {
		if (!itemPackedBase64) {
			return null
		}

		return unpack(Buffer.from(itemPackedBase64, "base64")) as DriveItem
	}, [itemPackedBase64])

	const [hexColor, setHexColor] = useState<string>(() => {
		if (!item || item.type !== "directory") {
			return directoryColorToHex(unwrapDirColor(DirColor.Default.new()))
		}

		return directoryColorToHex(unwrapDirColor(item.data.color))
	})

	if (!item || item.type !== "directory") {
		return (
			<Redirect
				href={{
					pathname: "/tabs/drive/[uuid]",
					params: {
						uuid: stringifiedClient?.rootUuid ?? "root"
					}
				}}
			/>
		)
	}

	return (
		<Fragment>
			<Header
				title="tbd_change_directory_color"
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
				rightItems={() => {
					if (!selectedColor) {
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
										console.error(result.error)
										alerts.error(result.error)

										return
									}

									setHexColor(selectedColor)
									setSelectedColor(null)
								}
							}
						}
					]
				}}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={Platform.select({
					ios: ["left", "right"],
					default: ["left", "right"]
				})}
			>
				<ScrollView
					contentContainerClassName={cn("bg-transparent px-4 flex-col pb-40 pt-10", Platform.OS === "ios" && "pt-24")}
					showsHorizontalScrollIndicator={true}
					showsVerticalScrollIndicator={false}
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
							{item.data.decryptedMeta?.name ?? item.data.uuid}
						</Text>
						<Text className="text-muted-foreground">tbd_directory</Text>
					</View>
					<View className="bg-background-tertiary rounded-3xl p-4 mt-10 items-center justify-center flex-row">
						<ColorPicker
							style={{
								width: "100%"
							}}
							value={hexColor}
							onCompleteJS={e => setSelectedColor(e.hex)}
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
					</View>
					<View className="bg-transparent mt-10">
						<Information item={item} />
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default ChangeDirectoryColor
