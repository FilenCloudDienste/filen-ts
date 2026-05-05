import { useEffect, useRef, memo, useCallback } from "react"
import type { DriveItem, DriveItemFileExtracted, DriveItemDirectoryExtracted } from "@/types"
import cache from "@/lib/cache"
import thumbnails from "@/lib/thumbnails"
import { run, runEffect } from "@filen/utils"
import Image from "@/components/ui/image"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import { type RenderTarget, useRecyclingState } from "@shopify/flash-list"
import { AppState } from "react-native"
import useHttpStore from "@/stores/useHttp.store"
import { useFocusEffect } from "expo-router"
import * as FileSystem from "expo-file-system"

const MAX_ERROR_RETRIES = 3
const MAX_GENERATE_RETRIES = 3

type ThumbnailSize = {
	icon: number
	thumbnail: number
}

const DirectoryThumbnail = memo(
	({ item, size, className }: { item: DriveItemDirectoryExtracted; size: ThumbnailSize; className?: string }) => {
		return (
			<DirectoryIcon
				color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
				width={size.icon}
				height={size.icon}
				className={className}
			/>
		)
	}
)

const FileThumbnailWithGenerate = memo(
	({
		item,
		size,
		className,
		contentFit,
		target = "Cell"
	}: {
		item: DriveItemFileExtracted
		size: ThumbnailSize
		className?: string
		contentFit?: React.ComponentProps<typeof Image>["contentFit"]
		target?: RenderTarget
	}) => {
		const abortControllerRef = useRef<AbortController | null>(null)
		const errorRetryCountRef = useRef<number>(0)
		const isGeneratingRef = useRef<boolean>(false)
		const localPathRef = useRef<string | null>(null)

		const [localPath, setLocalPath] = useRecyclingState<string | null>(
			() => {
				const available = cache.availableThumbnails.get(item.data.uuid)

				if (!available) {
					return null
				}

				return FileSystem.Paths.join(thumbnails.directory.uri, `${item.data.uuid}.webp`)
			},
			[item.data.uuid],
			() => {
				abortControllerRef.current?.abort()

				abortControllerRef.current = null
				errorRetryCountRef.current = 0
				isGeneratingRef.current = false
				localPathRef.current = null
			}
		)

		useEffect(() => {
			localPathRef.current = localPath
		}, [localPath])

		const generate = useCallback(async () => {
			if (target !== "Cell" || localPathRef.current || !thumbnails.canGenerate(item) || AppState.currentState !== "active") {
				return
			}

			const result = await run(async defer => {
				if (isGeneratingRef.current) {
					return
				}

				isGeneratingRef.current = true

				defer(() => {
					isGeneratingRef.current = false
				})

				if (localPathRef.current || AppState.currentState !== "active") {
					return
				}

				abortControllerRef.current?.abort()
				abortControllerRef.current = new AbortController()

				const signal = abortControllerRef.current.signal
				let lastError: unknown

				for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt++) {
					if (signal.aborted || AppState.currentState !== "active") {
						return
					}

					const result = await run(async () => {
						return await thumbnails.generate({
							item,
							signal
						})
					})

					if (signal.aborted) {
						return
					}

					if (result.success) {
						cache.availableThumbnails.set(item.data.uuid, true)

						setLocalPath(result.data)

						return
					}

					lastError = result.error

					await new Promise<void>(resolve => setTimeout(resolve, 1000))
				}

				console.error(lastError)

				cache.availableThumbnails.delete(item.data.uuid)
			})

			if (!result.success) {
				console.error(result.error)

				return
			}
		}, [item, setLocalPath, target])

		const generateRef = useRef(generate)

		useEffect(() => {
			generateRef.current = generate
		}, [generate])

		const onFailure = () => {
			cache.availableThumbnails.delete(item.data.uuid)

			if (errorRetryCountRef.current >= MAX_ERROR_RETRIES) {
				setLocalPath(null)

				return
			}

			errorRetryCountRef.current += 1

			thumbnails.remove(item)

			localPathRef.current = null

			setLocalPath(null)
		}

		const source = !localPath
			? null
			: {
					uri: localPath
				}

		const imageStyle = {
			width: size.thumbnail,
			height: size.thumbnail
		}

		useEffect(() => {
			if (!localPath) {
				generate()
			}
		}, [generate, localPath])

		useEffect(() => {
			const { cleanup } = runEffect(defer => {
				const appStateSubscription = AppState.addEventListener("change", nextAppState => {
					if (nextAppState === "background") {
						abortControllerRef.current?.abort()

						abortControllerRef.current = null
						isGeneratingRef.current = false
					} else if (nextAppState === "active") {
						if (!localPathRef.current) {
							generateRef.current?.()
						}
					}
				})

				defer(() => {
					appStateSubscription.remove()
				})

				const httpStoreUnsub = useHttpStore.subscribe(
					state => state.port,
					port => {
						if (!port) {
							abortControllerRef.current?.abort()

							abortControllerRef.current = null
							isGeneratingRef.current = false
						}
					}
				)

				defer(() => {
					httpStoreUnsub()
				})
			})

			return () => {
				cleanup()
			}
		}, [])

		useEffect(() => {
			return () => {
				abortControllerRef.current?.abort()

				abortControllerRef.current = null
				errorRetryCountRef.current = 0
				isGeneratingRef.current = false
			}
		}, [])

		useFocusEffect(
			useCallback(() => {
				if (!localPathRef.current) {
					generateRef.current?.()
				}

				return () => {
					abortControllerRef.current?.abort()

					abortControllerRef.current = null
					isGeneratingRef.current = false
				}
			}, [])
		)

		if (!localPath || !source) {
			return (
				<FileIcon
					name={item.data.decryptedMeta?.name ?? ""}
					width={size.icon}
					height={size.icon}
					className={className}
				/>
			)
		}

		return (
			<Image
				className={className}
				source={source}
				style={imageStyle}
				contentFit={contentFit ?? "contain"}
				cachePolicy="none"
				onError={onFailure}
				recyclingKey={`thumbnail-${item.data.uuid}`}
			/>
		)
	}
)

const FileThumbnail = memo(
	({
		item,
		size,
		className,
		contentFit,
		target
	}: {
		item: DriveItemFileExtracted
		size: ThumbnailSize
		className?: string
		contentFit?: React.ComponentProps<typeof Image>["contentFit"]
		target?: RenderTarget
	}) => {
		const [localPath] = useRecyclingState<string | null>(() => {
			const available = cache.availableThumbnails.get(item.data.uuid)

			if (!available) {
				return null
			}

			return FileSystem.Paths.join(thumbnails.directory.uri, `${item.data.uuid}.webp`)
		}, [item.data.uuid])

		const [didFail, setDidFail] = useRecyclingState<boolean>(false, [item.data.uuid])

		const source = !localPath
			? null
			: {
					uri: localPath
				}

		const imageStyle = {
			width: size.thumbnail,
			height: size.thumbnail
		}

		if (source && !didFail) {
			return (
				<Image
					className={className}
					source={source}
					style={imageStyle}
					contentFit={contentFit ?? "contain"}
					cachePolicy="none"
					onError={() => setDidFail(true)}
					recyclingKey={`thumbnail-${item.data.uuid}`}
				/>
			)
		}

		return (
			<FileThumbnailWithGenerate
				item={item}
				size={size}
				className={className}
				contentFit={contentFit}
				target={target}
			/>
		)
	}
)

const Thumbnail = memo(
	({
		item,
		size,
		className,
		contentFit,
		target
	}: {
		item: DriveItem
		size: ThumbnailSize
		className?: string
		contentFit?: React.ComponentProps<typeof Image>["contentFit"]
		target?: RenderTarget
	}) => {
		if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
			return (
				<FileThumbnail
					item={item}
					size={size}
					className={className}
					contentFit={contentFit}
					target={target}
				/>
			)
		}

		return (
			<DirectoryThumbnail
				item={item}
				size={size}
				className={className}
			/>
		)
	}
)

export default Thumbnail
