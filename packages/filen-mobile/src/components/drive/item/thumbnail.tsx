import { memo, useCallback, useMemo } from "@/lib/memo"
import { useEffect, useRef } from "react"
import type { ImageStyle } from "expo-image"
import type { DriveItem } from "@/types"
import cache from "@/lib/cache"
import thumbnails from "@/lib/thumbnails"
import { run } from "@filen/utils"
import Image from "@/components/ui/image"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import { useRecyclingState } from "@shopify/flash-list"

const MAX_ERROR_RETRIES = 3
const MAX_GENERATE_RETRIES = 3

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
		const abortControllerRef = useRef<AbortController | null>(null)
		const errorRetryCountRef = useRef(0)

		const [localPath, setLocalPath] = useRecyclingState<string | null>(
			() => {
				if (item.type !== "file" && item.type !== "sharedFile") {
					return null
				}

				const available = cache.availableThumbnails.get(item.data.uuid)

				if (!available) {
					return null
				}

				const exists = thumbnails.exists(item)

				return exists.exists ? exists.path : null
			},
			[item.data.uuid],
			() => {
				abortControllerRef.current?.abort()

				abortControllerRef.current = null
				errorRetryCountRef.current = 0
			}
		)

		const localPathRef = useRef(localPath)

		useEffect(() => {
			localPathRef.current = localPath
		}, [localPath])

		const generate = useCallback(async () => {
			if (localPathRef.current || (item.type !== "file" && item.type !== "sharedFile") || !thumbnails.canGenerate(item)) {
				return
			}

			abortControllerRef.current?.abort()
			abortControllerRef.current = new AbortController()

			const signal = abortControllerRef.current.signal
			let lastError: unknown

			for (let attempt = 0; attempt < MAX_GENERATE_RETRIES; attempt++) {
				if (signal.aborted) {
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
			}

			console.error(lastError)

			cache.availableThumbnails.set(item.data.uuid, false)
		}, [item, setLocalPath])

		const generateRef = useRef(generate)

		useEffect(() => {
			generateRef.current = generate
		}, [generate])

		const onError = useCallback(() => {
			cache.availableThumbnails.set(item.data.uuid, false)

			if (errorRetryCountRef.current >= MAX_ERROR_RETRIES) {
				setLocalPath(null)

				return
			}

			errorRetryCountRef.current += 1

			thumbnails.remove(item)

			localPathRef.current = null

			setLocalPath(null)

			generateRef.current?.()
		}, [item, setLocalPath])

		useEffect(() => {
			errorRetryCountRef.current = 0

			if (!localPathRef.current) {
				generate()
			}
		}, [generate])

		useEffect(() => {
			return () => {
				abortControllerRef.current?.abort()

				abortControllerRef.current = null
			}
		}, [])

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
