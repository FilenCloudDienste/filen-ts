import { useIncomingShare, type ResolvedSharePayload } from "expo-sharing"
import { Platform } from "react-native"
import { useTranslation } from "react-i18next"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import { Fragment, useCallback, useEffect, useRef } from "react"
import Header from "@/components/ui/header"
import { useResolveClassNames } from "uniwind"
import { useNavigation, useFocusEffect } from "expo-router"
import VirtualList from "@/components/ui/virtualList"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import * as FileSystem from "expo-file-system"
import transfers from "@/features/transfers/transfers"
import { run, formatBytes } from "@filen/utils"
import alerts from "@/lib/alerts"
import useIsOnline from "@/hooks/useIsOnline"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import { resolveSelectedDriveItemToAnyNormalDir } from "@/features/drive/driveSelectResolve"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { newTmpFile } from "@/lib/tmp"
import { isEqual } from "es-toolkit"
import useIncomingShareStore from "@/features/incomingShare/store/useIncomingShare.store"
import Image from "@/components/ui/image"
import { getPreviewType } from "@/lib/previewType"
import { FileIcon } from "@/components/itemIcons"
import ListRow from "@/components/ui/listRow"
import logger from "@/lib/logger"

function Payload({ payload }: { payload: ResolvedSharePayload }) {
	const previewType =
		payload.contentUri && payload.originalName && payload.contentUri.startsWith("file://") ? getPreviewType(payload.originalName) : null

	return (
		<ListRow
			separator={true}
			density="relaxed"
			leading={
				previewType === "image" ? (
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
				)
			}
			title={payload.originalName}
			subtitle={typeof payload.contentSize === "number" ? formatBytes(payload.contentSize) : undefined}
		/>
	)
}

function IncomingShare() {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const insets = useSafeAreaInsets()
	const { resolvedSharedPayloads, isResolving, error } = useIncomingShare()
	const textBlue500 = useResolveClassNames("text-blue-500")
	const navigation = useNavigation()
	const currentPayloadsRef = useRef<ResolvedSharePayload[]>([])
	const isUploadingRef = useRef(false)
	const isOnline = useIsOnline()

	const payloads = resolvedSharedPayloads.filter(
		payload => typeof payload.contentUri === "string" && typeof payload.originalName === "string"
	)

	// True while the OS share extension is still resolving payloads. The expo-sharing hook
	// initialises with isResolving=false / resolvedSharedPayloads=[] and only sets isResolving=true
	// in a post-commit useEffect, so we treat an empty payload list with no error as still-loading
	// to suppress the "no resolved shares" empty state on the first render frame.
	const isLoadingPayloads = isResolving || (!error && resolvedSharedPayloads.length === 0)

	const clear = useCallback(async (paylodsToClear: ResolvedSharePayload[]) => {
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
		if (!isResolving && !error && !isEqual(currentPayloadsRef.current, resolvedSharedPayloads)) {
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

	const handleUpload = useCallback(async () => {
		if (isUploadingRef.current) {
			return
		}

		isUploadingRef.current = true

		try {
			const selectResult = await run(async () => {
				return await selectDriveItems({
					type: "single",
					files: false,
					directories: true,
					items: []
				})
			})

			if (!selectResult.success) {
				logger.error("incomingShare", "failed to open directory picker", { error: selectResult.error })
				alerts.error(selectResult.error)

				return
			}

			if (selectResult.data.cancelled) {
				return
			}

			const selectedItem = selectResult.data.selectedItems[0]

			if (!selectedItem) {
				return
			}

			const remoteDir = resolveSelectedDriveItemToAnyNormalDir(selectedItem)

			if (!remoteDir) {
				// The helper already logged the uuid/type diagnostics for the unresolved pick.
				logger.warn("incomingShare", "selected directory could not be resolved, upload aborted")

				return
			}

			const assetsResult = await runWithLoading(async defer => {
				return await Promise.all(
					payloads.map(async payload => {
						if (!payload.contentUri || !payload.originalName) {
							logger.warn("incomingShare", "payload missing contentUri or originalName, skipping", { contentUri: payload.contentUri ?? null, originalName: payload.originalName ?? null })

							return null
						}

						const file = new FileSystem.File(payload.contentUri)

						defer(() => {
							if (file.exists) {
								file.delete()
							}
						})

						const tmpFile = newTmpFile()

						if (tmpFile.exists) {
							tmpFile.delete()
						}

						await file.copy(tmpFile)

						return {
							name: payload.originalName,
							file: tmpFile
						}
					})
				)
			})

			if (!assetsResult.success) {
				logger.error("incomingShare", "failed to copy share payloads to tmp dir", { error: assetsResult.error, payloadCount: payloads.length })
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

			navigation.getParent()?.goBack()

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
							parent: remoteDir,
							name: asset.name
						})
					})
				)
			})

			if (!result.success) {
				logger.error("incomingShare", "upload of shared files failed", { error: result.error, assetCount: assets.length })
				alerts.error(result.error)

				return
			}
		} finally {
			isUploadingRef.current = false
		}
	}, [payloads, navigation, clear])

	useFocusEffect(
		useCallback(() => {
			useIncomingShareStore.getState().setProcess(false)

			return () => {
				useIncomingShareStore.getState().setProcess(false)
			}
		}, [])
	)

	return (
		<Fragment>
			<Header
				title={t("saved_shares")}
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
									navigation.getParent()?.goBack()
								}
							}
						}
					],
					default: undefined
				})}
				rightItems={
					payloads.length > 0 && isOnline
						? [
								{
									type: "button",
									icon: {
										name: "checkmark-outline",
										color: textBlue500.color,
										size: 20
									},
									props: {
										onPress: handleUpload
									}
								}
							]
						: undefined
				}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={payloads}
					loading={isLoadingPayloads}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					emptyComponent={() =>
						error ? (
							<ListEmpty
								icon="warning-outline"
								title={t("error_resolving_shares")}
								description={t("error_resolving_shares_description")}
							/>
						) : (
							<ListEmpty
								icon="time-outline"
								title={t("no_resolved_shares")}
								description={t("no_resolved_shares_description")}
							/>
						)
					}
					renderItem={({ item: payload }) => {
						return <Payload payload={payload} />
					}}
					keyExtractor={payload => payload.contentUri ?? payload.originalName ?? JSON.stringify(payload)}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default IncomingShare
