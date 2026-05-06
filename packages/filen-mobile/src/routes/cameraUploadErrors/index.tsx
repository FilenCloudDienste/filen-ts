import Text from "@/components/ui/text"
import { Platform } from "react-native"
import { router } from "expo-router"
import View from "@/components/ui/view"
import Header, { type HeaderItem } from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import VirtualList from "@/components/ui/virtualList"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useCameraUploadStore, { type CameraUploadError } from "@/stores/useCameraUpload.store"
import { useShallow } from "zustand/shallow"
import { unwrapSdkError, unwrappedSdkErrorToHumanReadable } from "@/lib/utils"
import cameraUpload from "@/lib/cameraUpload"

const Err = memo(({ error }: { error: CameraUploadError }) => {
	const errorMessage = (() => {
		if (!error.error) {
			return "tbd_unknown_error"
		}

		const unwrappedError = unwrapSdkError(error.error)

		if (unwrappedError) {
			return unwrappedSdkErrorToHumanReadable(unwrappedError)
		}

		if (error.error instanceof Error) {
			return (error.error as Error).message
		}

		if (typeof error.error === "string") {
			return error.error
		}

		return "tbd_unknown_error"
	})()

	return (
		<View className="flex-row items-center px-4 bg-transparent flex-1">
			<View className="flex-row items-center py-3 border-b border-border flex-1 bg-transparent">
				<Text>{errorMessage}</Text>
			</View>
		</View>
	)
})

const CameraUploadErrors = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const insets = useSafeAreaInsets()
	const errors = useCameraUploadStore(useShallow(state => state.errors))

	return (
		<Fragment>
			<Header
				title="tbd_camera_upload_errors"
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
								name: "chevron-back-outline",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									router.back()
								}
							}
						}
					] satisfies HeaderItem[],
					default: undefined
				})}
				rightItems={[
					{
						type: "menu",
						props: {
							type: "dropdown",
							hitSlop: 20,
							buttons: [
								{
									id: "clear",
									icon: "edit",
									title: "tbd_clear_errors",
									onPress: () => {
										useCameraUploadStore.getState().setErrors([])

										cameraUpload.sync().catch(console.error)
									}
								},
								{
									id: "settings",
									icon: "edit",
									title: "tbd_settings",
									onPress: () => {
										router.push("/cameraUpload")
									}
								}
							]
						},
						triggerProps: {
							hitSlop: 20
						},
						icon: {
							name: "ellipsis-horizontal",
							size: 24,
							color: textForeground.color
						}
					}
				]}
			/>
			<VirtualList
				data={errors}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{
					paddingBottom: insets.bottom
				}}
				emptyComponent={() => {
					return (
						<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
							<Ionicons
								name="checkmark-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text>tbd_no_camera_upload_errors</Text>
						</View>
					)
				}}
				renderItem={({ item: error }) => {
					return <Err error={error} />
				}}
				keyExtractor={error => error.id}
			/>
		</Fragment>
	)
})

export default CameraUploadErrors
