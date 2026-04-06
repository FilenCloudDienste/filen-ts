import * as FileSystem from "expo-file-system"
import { Semaphore, run } from "@filen/utils"
import { IOS_APP_GROUP_IDENTIFIER, MUSIC_METADATA_SUPPORTED_EXTENSIONS } from "@/constants"
import { Platform } from "react-native"
import type { DriveItem } from "@/types"
import { serialize, deserialize } from "@/lib/serializer"
import fileCache from "@/lib/fileCache"
import { parseWebStream } from "music-metadata"
import { Image, type ImageRef } from "expo-image"

export type Metadata = {
	pictureBase64?: string | null
	pictureBlurhash?: string | null
	artist?: string | null
	title?: string | null
	album?: string | null
	date?: string | null
	duration?: number | null
	cachedAt: number
} | null

// Critical: When changing anything related to storage index/store/persistence format, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 1

export class AudioCache {
	private readonly parentDirectory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				"audioCache",
				`v${VERSION}`
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document, "audioCache", `v${VERSION}`)
		})
	)
	private readonly mutexes = new Map<string, Semaphore>()

	private ensureDirectory(): void {
		if (!this.parentDirectory.exists) {
			this.parentDirectory.create({
				idempotent: true,
				intermediates: true
			})
		}
	}

	public constructor() {
		this.ensureDirectory()
	}

	private getMutexForKey(key: string): Semaphore {
		let mutex = this.mutexes.get(key)

		if (!mutex) {
			mutex = new Semaphore(1)

			this.mutexes.set(key, mutex)
		}

		return mutex
	}

	public getFiles(item: DriveItem): {
		audio: FileSystem.File
		metadata: FileSystem.File
	} {
		const { file: dataFile } = fileCache.getFiles(item)

		return {
			audio: dataFile,
			metadata: new FileSystem.File(FileSystem.Paths.join(this.parentDirectory.uri, `${item.data.uuid}.filenmeta`))
		}
	}

	public async has(item: DriveItem): Promise<boolean> {
		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			return false
		}

		const { audio, metadata } = this.getFiles(item)

		if (!audio.exists || !metadata.exists || metadata.size === 0) {
			return false
		}

		const metadataContent = deserialize(await metadata.text()) as Metadata

		if (Object.keys(metadataContent ?? {}).length === 0) {
			return false
		}

		return true
	}

	public async getMetadata({ item, signal }: { item: DriveItem; signal?: AbortSignal }): Promise<Metadata> {
		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		return (
			await this.get({
				item,
				signal
			})
		).metadata
	}

	public async get({ item, signal }: { item: DriveItem; signal?: AbortSignal }): Promise<{
		audio: FileSystem.File
		metadata: Metadata
	}> {
		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			if (!item.data.decryptedMeta) {
				throw new Error("Item metadata is not decrypted")
			}

			const mutex = this.getMutexForKey(item.data.uuid)

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { audio, metadata: metadataFile } = this.getFiles(item)

			if (audio.exists && metadataFile.exists && metadataFile.size > 0) {
				const metadata = deserialize(await metadataFile.text()) as Metadata

				if (Object.keys(metadata ?? {}).length > 0) {
					return {
						audio,
						metadata
					}
				}
			}

			const audioFile = await fileCache.get({
				item,
				signal
			})

			let metadata: Metadata = null

			if (MUSIC_METADATA_SUPPORTED_EXTENSIONS.has(FileSystem.Paths.extname(item.data.decryptedMeta.name).toLowerCase().trim())) {
				try {
					if (!metadataFile.exists || metadataFile.size === 0) {
						if (!audioFile.exists) {
							throw new Error("Audio file does not exist after download")
						}

						const parsedMetadata = await parseWebStream(audioFile.stream(), {
							mimeType: item.data.decryptedMeta.mime,
							size: Number(item.data.size)
						})

						const picture = parsedMetadata?.common?.picture?.at(0)
						const pictureBase64 = picture
							? `data:${picture.format};base64,${Buffer.from(picture.data).toString("base64")}`
							: null
						let pictureBlurhash: string | null = null

						if (pictureBase64) {
							let image: ImageRef | null = null

							try {
								image = await Image.loadAsync(pictureBase64)
								pictureBlurhash = await Image.generateBlurhashAsync(image, [4, 3])
							} catch (e) {
								console.error(e)
							} finally {
								if (image) {
									image.release()

									image = null
								}
							}
						}

						metadata = {
							pictureBase64,
							pictureBlurhash,
							artist: parsedMetadata.common?.artist ?? null,
							title: parsedMetadata.common?.title ?? null,
							album: parsedMetadata.common?.album ?? null,
							date: parsedMetadata.common?.date ?? null,
							duration: parsedMetadata.format?.duration ? Math.round(parsedMetadata.format.duration) : null,
							cachedAt: Date.now()
						}

						if (metadataFile.exists) {
							metadataFile.delete()
						}

						metadataFile.create({
							intermediates: true
						})

						metadataFile.write(serialize(metadata))
					} else {
						metadata = deserialize(await metadataFile.text()) as Metadata

						if (Object.keys(metadata ?? {}).length === 0) {
							metadata = null
						}
					}
				} catch (e) {
					console.error(e)

					if (metadataFile.exists) {
						metadataFile.delete()
					}
				}
			}

			return {
				audio: audioFile,
				metadata
			}
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async remove(item: DriveItem): Promise<void> {
		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			const mutex = this.getMutexForKey(item.data.uuid)

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { metadata: metadataFile } = this.getFiles(item)

			if (metadataFile.exists) {
				metadataFile.delete()
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async gc(age?: number): Promise<void> {
		const now = Date.now()
		const entries = this.parentDirectory.list()

		await Promise.all(
			entries.map(async entry => {
				await run(
					async defer => {
						if (!(entry instanceof FileSystem.File)) {
							return
						}

						const metadata = deserialize(await entry.text()) as Metadata

						if (Object.keys(metadata ?? {}).length === 0 || now > (metadata?.cachedAt ?? 0) + (age ?? 86400 * 1000)) {
							const mutex = this.getMutexForKey(entry.name.replace(".filenmeta", ""))

							await mutex.acquire()

							defer(() => {
								mutex.release()
							})

							entry.delete()
						}
					},
					{
						throw: true
					}
				)
			})
		)
	}
}

const audioCache = new AudioCache()

export default audioCache
