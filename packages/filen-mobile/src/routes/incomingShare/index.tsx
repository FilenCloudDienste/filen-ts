import { useIncomingShare, type ResolvedSharePayload } from "expo-sharing"
import { Platform } from "react-native"
import View from "@/components/ui/view"
import { memo, Fragment, useCallback, useEffect, useRef } from "react"
import Header from "@/components/ui/header"
import { useResolveClassNames } from "uniwind"
import { router, useNavigation } from "expo-router"
import VirtualList from "@/components/ui/virtualList"
import Text from "@/components/ui/text"
import Ionicons from "@expo/vector-icons/Ionicons"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import * as FileSystem from "expo-file-system"
import transfers from "@/lib/transfers"
import { run, formatBytes } from "@filen/utils"
import alerts from "@/lib/alerts"
import { selectDriveItems } from "@/routes/driveSelect/[uuid]"
import cache from "@/lib/cache"
import { AnyNormalDir_Tags } from "@filen/sdk-rs"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { randomUUID } from "expo-crypto"
import isEqual from "react-fast-compare"
import useEffectOnce from "@/hooks/useEffectOnce"
import useIncomingShareStore from "@/stores/useIncomingShare.store"
import Image from "@/components/ui/image"
import { getPreviewType } from "@/lib/utils"
import { FileIcon } from "@/components/itemIcons"

const Payload = memo(({ payload }: { payload: ResolvedSharePayload }) => {
	const previewType =
		payload.contentUri && payload.originalName && payload.contentUri.startsWith("file://") ? getPreviewType(payload.originalName) : null

	return (
		<View className="px-4 bg-transparent flex-row items-center">
			<View className="py-3 bg-transparent border-b border-border flex-row items-center gap-4">
				{previewType === "image" ? (
					<Image
						className="bg-transparent"
						source={{
							uri: payload.contentUri ?? undefined
						}}
						style={{
							width: 32,
							height: 32
						}}
						contentFit="contain"
						cachePolicy="none"
						recyclingKey={`thumbnail-${payload.contentUri}`}
					/>
				) : (
					<FileIcon
						name={payload.originalName ?? "file"}
						width={32}
						height={32}
					/>
				)}
				<View className="flex-col flex-1 bg-transparent">
					<Text
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{payload.originalName}
					</Text>
					{typeof payload.contentSize === "number" && (
						<Text
							className="text-muted-foreground text-xs"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{formatBytes(payload.contentSize)}
						</Text>
					)}
				</View>
			</View>
		</View>
	)
})

const IncomingShare = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const insets = useSafeAreaInsets()
	const { resolvedSharedPayloads, isResolving, error } = useIncomingShare()
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const navigation = useNavigation()
	const currentPayloadsRef = useRef<ResolvedSharePayload[]>([])

	const payloads = resolvedSharedPayloads.filter(
		payload => typeof payload.contentUri === "string" && typeof payload.originalName === "string"
	)

	const clear = useCallback(async (paylodsToClear: ResolvedSharePayload[]) => {
		console.log("Clearing shared payloads and deleting files")

		await run(() => {
			for (const payload of paylodsToClear) {
				if (!payload.contentUri) {
					continue
				}

				const file = new FileSystem.File(payload.contentUri)

				if (file.exists) {
					file.delete()
				}
			}
		})
	}, [])

	useEffect(() => {
		if (!isResolving || !error || !isEqual(currentPayloadsRef.current, resolvedSharedPayloads)) {
			clear(currentPayloadsRef.current)

			currentPayloadsRef.current = resolvedSharedPayloads
		}
	}, [resolvedSharedPayloads, clear, isResolving, error])

	useEffect(() => {
		const unsubscribe = navigation.addListener("beforeRemove", () => {
			clear(currentPayloadsRef.current)
		})

		return unsubscribe
	}, [navigation, clear])

	useEffectOnce(() => {
		useIncomingShareStore.getState().setProcess(false)
	})

	return (
		<Fragment>
			<Header
				title="tbd_saved_shares"
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
				rightItems={
					payloads.length > 0
						? [
								{
									type: "button",
									icon: {
										name: "checkmark-outline",
										color: textBlue500.color,
										size: 20
									},
									props: {
										onPress: async () => {
											const selectResult = await run(async () => {
												return await selectDriveItems({
													type: "single",
													files: false,
													directories: true,
													items: []
												})
											})

											if (!selectResult.success) {
												console.error(selectResult.error)
												alerts.error(selectResult.error)

												return
											}

											if (selectResult.data.cancelled) {
												return
											}

											const selectedItem = selectResult.data.selectedItems[0]

											if (!selectedItem || selectedItem.type !== "directory") {
												return
											}

											const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.uuid)

											if (!fromCache || fromCache.tag !== AnyNormalDir_Tags.Dir) {
												return
											}

											const assetsResult = await runWithLoading(async defer => {
												return await Promise.all(
													payloads.map(async payload => {
														if (!payload.contentUri || !payload.originalName) {
															return null
														}

														const file = new FileSystem.File(payload.contentUri)

														defer(() => {
															if (file.exists) {
																file.delete()
															}
														})

														const tmpFile = new FileSystem.File(
															FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID())
														)

														if (tmpFile.exists) {
															tmpFile.delete()
														}

														file.copy(tmpFile)

														return {
															name: payload.originalName,
															file: tmpFile
														}
													})
												)
											})

											if (!assetsResult.success) {
												console.error(assetsResult.error)
												alerts.error(assetsResult.error)

												return
											}

											const assets = assetsResult.data.filter(
												(
													asset
												): asset is {
													name: string
													file: FileSystem.File
												} => asset !== null
											)

											clear(currentPayloadsRef.current)

											if (router.canDismiss()) {
												router.dismissAll()
											}

											const result = await run(async defer => {
												return await Promise.all(
													assets.map(async asset => {
														defer(() => {
															if (asset.file.exists) {
																asset.file.delete()
															}
														})

														return await transfers.upload({
															localFileOrDir: asset.file,
															parent: fromCache,
															name: asset.name
														})
													})
												)
											})

											if (!result.success) {
												console.error(result.error)
												alerts.error(result.error)

												return
											}
										}
									}
								}
							]
						: undefined
				}
			/>
			<VirtualList
				data={payloads}
				loading={isResolving}
				contentInsetAdjustmentBehavior="automatic"
				contentContainerStyle={{
					paddingBottom: insets.bottom
				}}
				emptyComponent={() => {
					if (error) {
						return (
							<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
								<Ionicons
									name="warning-outline"
									size={64}
									color={textMutedForeground.color}
								/>
								<Text>tbd_error_resolving_shares</Text>
							</View>
						)
					}

					return (
						<View className="flex-1 items-center justify-center bg-transparent gap-2 -mt-40">
							<Ionicons
								name="time-outline"
								size={64}
								color={textMutedForeground.color}
							/>
							<Text>tbd_no_resolved_shares</Text>
						</View>
					)
				}}
				renderItem={({ item: payload }) => {
					return <Payload payload={payload} />
				}}
				keyExtractor={payload => JSON.stringify(payload)}
			/>
		</Fragment>
	)
})

export default IncomingShare
