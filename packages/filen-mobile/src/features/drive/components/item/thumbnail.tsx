import { useEffect, useRef, useCallback, type RefObject } from "react"
import type { DriveItem, DriveItemFileExtracted, DriveItemDirectoryExtracted } from "@/types"
import thumbnails from "@/lib/thumbnails"
import { getPath } from "@/lib/thumbnailsHelpers"
import { run, runEffect } from "@filen/shared"
import Image from "@/components/ui/image"
import { FileIcon, DirectoryIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import { type RenderTarget, useRecyclingState } from "@shopify/flash-list"
import { AppState } from "react-native"
import useHttpStore from "@/stores/useHttp.store"
import { useFocusEffect } from "expo-router"
import logger from "@/lib/logger"
import { isFileItem } from "@/features/drive/driveSelectors"

const MAX_ERROR_RETRIES = 3
const MAX_GENERATE_RETRIES = 3

type ThumbnailSize = {
	icon: number
	thumbnail: number
}

function cancelGenerate(abortControllerRef: RefObject<AbortController | null>, isGeneratingRef: RefObject<boolean>): void {
	abortControllerRef.current?.abort()

	abortControllerRef.current = null
	isGeneratingRef.current = false
}

const DirectoryThumbnail = ({ item, size, className }: { item: DriveItemDirectoryExtracted; size: ThumbnailSize; className?: string }) => {
	return (
		<DirectoryIcon
			color={item.type === "directory" ? item.data.color : DirColor.Default.new()}
			width={size.icon}
			height={size.icon}
			className={className}
		/>
	)
}

const FileThumbnailWithGenerate = ({
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
	// Latches true once an item has exhausted its render-error retry budget. An undecodable-but-
	// nonzero .webp would otherwise loop forever: <Image> onError → regenerate → same bad bytes →
	// onError. Once latched, every regeneration entry point bails so the cell renders the static
	// FileIcon instead. Reset on recycle below so a recycled cell starts fresh for its new item.
	const failedPermanentlyRef = useRef<boolean>(false)

	const [localPath, setLocalPath] = useRecyclingState<string | null>(
		() => (thumbnails.hasThumbnail(item.data.uuid) ? getPath(item) : null),
		[item.data.uuid],
		() => {
			cancelGenerate(abortControllerRef, isGeneratingRef)

			errorRetryCountRef.current = 0
			localPathRef.current = null
			failedPermanentlyRef.current = false
		}
	)

	useEffect(() => {
		localPathRef.current = localPath
	}, [localPath])

	const generate = useCallback(async () => {
		if (
			target !== "Cell" ||
			localPathRef.current ||
			failedPermanentlyRef.current ||
			// Settled by the lib for this session — a sync Set read; the verdict disappears on the
			// online flip, after which the next entry point regenerates.
			thumbnails.isUnavailable(item.data.uuid) ||
			!thumbnails.canGenerate(item) ||
			AppState.currentState !== "active"
		) {
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
					if (result.data === null) {
						// Settled by the lib: the icon stays and no retry iteration runs. Deliberately NOT
						// latched here — the lib's Set is consulted again on the next entry point, so a
						// session verdict cleared on the online flip regenerates.
						return
					}

					setLocalPath(result.data)

					return
				}

				lastError = result.error

				await new Promise<void>(resolve => setTimeout(resolve, 1000))
			}

			logger.warn("drive", "thumbnail generation failed after retries", { error: lastError, uuid: item.data.uuid })
		})

		if (!result.success) {
			logger.warn("drive", "thumbnail generate run failed", { error: result.error, uuid: item.data.uuid })

			return
		}
	}, [item, setLocalPath, target])

	const generateRef = useRef(generate)

	useEffect(() => {
		generateRef.current = generate
	}, [generate])

	const onFailure = () => {
		if (errorRetryCountRef.current >= MAX_ERROR_RETRIES) {
			// Retry budget exhausted. Drop the corrupt on-disk artifact but PRESERVE the lib's
			// failure counter (invalidateFile, not remove) and latch failedPermanentlyRef so no
			// regeneration entry point re-fires. Renders the static FileIcon from here on.
			failedPermanentlyRef.current = true

			thumbnails.invalidateFile(item)

			localPathRef.current = null

			setLocalPath(null)

			return
		}

		errorRetryCountRef.current += 1

		// Non-terminal: discard the bad artifact and try again, but use invalidateFile (NOT remove)
		// so the lib-side this.failures history survives — remove() would wipe it and uncap the
		// underlying generate-on-error loop.
		thumbnails.invalidateFile(item)

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
		if (!localPath && !failedPermanentlyRef.current) {
			generate()
		}
	}, [generate, localPath])

	useEffect(() => {
		const { cleanup } = runEffect(defer => {
			const appStateSubscription = AppState.addEventListener("change", nextAppState => {
				if (nextAppState === "background") {
					cancelGenerate(abortControllerRef, isGeneratingRef)
				} else if (nextAppState === "active") {
					if (!localPathRef.current && !failedPermanentlyRef.current) {
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
						cancelGenerate(abortControllerRef, isGeneratingRef)
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
			cancelGenerate(abortControllerRef, isGeneratingRef)
		}
	}, [])

	useFocusEffect(
		useCallback(() => {
			if (!localPathRef.current && !failedPermanentlyRef.current) {
				generateRef.current?.()
			}

			return () => {
				cancelGenerate(abortControllerRef, isGeneratingRef)
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

const FileThumbnail = ({
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
	const [localPath] = useRecyclingState<string | null>(() => (thumbnails.hasThumbnail(item.data.uuid) ? getPath(item) : null), [item.data.uuid])

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

	// The static icon with no generator mounted, whose effects would only call generate() to be told
	// null again: a session verdict (until the next online flip), or, with no cached path, an item the
	// lib can never thumbnail (canGenerate is a pure function of the item). The hasThumbnail guard
	// keeps a generator mounted for a thumbnail generated in-cell before a rename to a non-media name.
	if (
		thumbnails.isUnavailable(item.data.uuid) ||
		(!source && !thumbnails.hasThumbnail(item.data.uuid) && !thumbnails.canGenerate(item))
	) {
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
		<FileThumbnailWithGenerate
			item={item}
			size={size}
			className={className}
			contentFit={contentFit}
			target={target}
		/>
	)
}

const Thumbnail = ({
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
	if (isFileItem(item)) {
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

export default Thumbnail
