import { memo, useCallback, useMemo } from "@/lib/memo"
import useEffectOnce from "@/hooks/useEffectOnce"
import { useEffect, useRef, useState } from "react"
import type { ImageStyle } from "expo-image"
import type { DriveItem } from "@/types"
import cache from "@/lib/cache"
import thumbnails from "@/lib/thumbnails"
import { run } from "@filen/utils"
import Image from "@/components/ui/image"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import useHttpStore from "@/stores/useHttp.store"
import { EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"

const Thumbnail = memo(
	({
		item,
		size,
		className
	}: {
		item: DriveItem
		size: {
			icon: number
			thumbnail: number
		}
		className?: string
	}) => {
		const availableFromCache = item.type === "file" || item.type === "sharedFile" ? cache.availableThumbnails.get(item.data.uuid) : null
		const existsOnDisk = availableFromCache ? thumbnails.exists(item) : null
		const [localPath, setLocalPath] = useState<string | null>(existsOnDisk?.exists ? existsOnDisk.path : null)
		const abortControllerRef = useRef<AbortController | null>(null)

		const generate = useCallback(async () => {
			if (localPath || (item.type !== "file" && item.type !== "sharedFile") || !thumbnails.canGenerate(item)) {
				return
			}

			abortControllerRef.current?.abort()
			abortControllerRef.current = new AbortController()

			const signal = abortControllerRef.current.signal

			const result = await run(async () => {
				return await thumbnails.generate({
					item,
					signal
				})
			})

			if (!result.success) {
				console.error(result.error)

				cache.availableThumbnails.set(item.data.uuid, false)

				return
			}

			cache.availableThumbnails.set(item.data.uuid, true)

			setLocalPath(result.data)
		}, [item, localPath])

		const onError = useCallback(() => {
			cache.availableThumbnails.set(item.data.uuid, false)

			setLocalPath(null)
		}, [item])

		useEffectOnce(() => {
			generate()
		})

		const source = useMemo(
			() => ({
				uri: localPath ?? undefined
			}),
			[localPath]
		)

		const imageStyle = useMemo<ImageStyle>(
			() => ({
				width: size.thumbnail,
				height: size.thumbnail
			}),
			[size.thumbnail]
		)

		const isVideo = useMemo(() => {
			if (item.type !== "file" && item.type !== "sharedFile") {
				return false
			}

			const name = item.data.decryptedMeta?.name

			if (!name) {
				return false
			}

			const dotIndex = name.lastIndexOf(".")

			if (dotIndex < 0) {
				return false
			}

			return EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(name.slice(dotIndex).toLowerCase().trim())
		}, [item])

		useEffect(() => {
			return () => {
				abortControllerRef.current?.abort()

				abortControllerRef.current = null
			}
		}, [])

		useEffect(() => {
			if (!isVideo) {
				return
			}

			const unsubscribe = useHttpStore.subscribe(
				s => s.port,
				port => {
					if (port === null) {
						abortControllerRef.current?.abort()

						abortControllerRef.current = null
					}
				}
			)

			return () => {
				unsubscribe()
			}
		}, [isVideo])

		if (item.type !== "file" && item.type !== "sharedFile") {
			return (
				<DirectoryIcon
					color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
					width={size.icon}
					height={size.icon}
					className={className}
				/>
			)
		}

		if (!localPath || !source.uri) {
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
				contentFit="contain"
				cachePolicy="none"
				onError={onError}
			/>
		)
	}
)

export default Thumbnail
