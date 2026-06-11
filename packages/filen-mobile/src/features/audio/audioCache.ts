import * as FileSystem from "expo-file-system"
import { AppState } from "react-native"
import { Semaphore, run } from "@filen/utils"
import { debounce } from "es-toolkit/function"
import { ClearBarrier } from "@/lib/clearBarrier"
import { MUSIC_METADATA_SUPPORTED_EXTENSIONS, AUDIO_METADATA_MAX_PARSE_SIZE_BYTES, AUDIO_METADATA_MAX_CONCURRENT_PARSES } from "@/constants"
import { serialize, deserialize } from "@/lib/serializer"
import { atomicWrite } from "@/lib/fsAtomic"
import fileCache from "@/lib/fileCache"
import { parseWebStream } from "music-metadata"
import { Image, type ImageRef } from "expo-image"
import { xxHash32 } from "js-xxhash"
import mimeTypes from "mime-types"
import type { CacheItem } from "@/types"
import { AUDIO_CACHE_VERSION, AUDIO_CACHE_PARENT_DIRECTORY } from "@/lib/storageRoots"

export type Metadata = {
	pictureUri?: string | null
	pictureBlurhash?: string | null
	artist?: string | null
	title?: string | null
	album?: string | null
	date?: string | null
	duration?: number | null
	cachedAt: number
} | null

// Critical: When changing anything related to storage index/store/persistence format, bump AUDIO_CACHE_VERSION in storageRoots.ts to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = AUDIO_CACHE_VERSION
export const PARENT_DIRECTORY = AUDIO_CACHE_PARENT_DIRECTORY

const GC_DEBOUNCE_MS = 30 * 1000

function parseMetadata(raw: string): Metadata {
	const result = deserialize<unknown>(raw)

	return typeof result === "object" && result !== null && typeof (result as { cachedAt?: unknown }).cachedAt === "number"
		? (result as Metadata)
		: null
}

function hasMetadata(m: Metadata): m is NonNullable<Metadata> {
	return m !== null && Object.keys(m).length > 0
}

// music-metadata's `parseWebStream` runs on the JS thread; for large inputs it can visibly
// degrade JS-thread performance (headerless-VBR duration scans, large embedded cover art,
// general stream/parse overhead). Skip parsing a file whose size is KNOWN to exceed the cap —
// the track still plays, it just has no cached cover/tags. An unknown size (rare for a
// downloaded file) falls through and parses as before, so this never regresses that case.
function audioFileTooLargeToParse(sizeBytes: number | null | undefined): boolean {
	return typeof sizeBytes === "number" && sizeBytes > AUDIO_METADATA_MAX_PARSE_SIZE_BYTES
}

export class AudioCache {
	private readonly mutexes = new Map<string, Semaphore>()
	private readonly clearBarrier = new ClearBarrier()
	// Global gate so concurrent metadata fetches across different items don't pile
	// parseWebStream's JS-thread work on at once (Hermes is single-threaded — see
	// AUDIO_METADATA_MAX_CONCURRENT_PARSES). The per-key mutex below only serializes
	// the SAME item; this bounds parses across ALL items.
	private readonly parseSemaphore = new Semaphore(AUDIO_METADATA_MAX_CONCURRENT_PARSES)

	private ensureDirectory(): void {
		if (!PARENT_DIRECTORY.exists) {
			PARENT_DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		}
	}

	// Debounced gc after metadata writes + immediate gc on app-background:
	// reclamation runs where growth happens instead of competing with startup.
	// Log-only on failure — gc hygiene isn't user-actionable.
	private readonly scheduleGc = debounce(
		() => {
			this.gc().catch(err => {
				console.error("[AudioCache] gc failed", err)
			})
		},
		GC_DEBOUNCE_MS,
		{
			edges: ["trailing"]
		}
	)

	public constructor() {
		this.ensureDirectory()

		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				this.scheduleGc.cancel()

				this.gc().catch(err => {
					console.error("[AudioCache] gc failed", err)
				})
			}
		})
	}

	private getMutexForKey(key: string): Semaphore {
		let mutex = this.mutexes.get(key)

		if (!mutex) {
			mutex = new Semaphore(1)

			this.mutexes.set(key, mutex)
		}

		return mutex
	}

	private getExternalItemId(item: Extract<CacheItem, { type: "external" }>): string {
		return xxHash32(item.data.url).toString(16)
	}

	public getFiles(item: CacheItem): {
		audio: FileSystem.File
		metadata: FileSystem.File
	} {
		const { file: dataFile } = fileCache.getFiles(item)

		return {
			audio: dataFile,
			metadata: new FileSystem.File(
				FileSystem.Paths.join(
					PARENT_DIRECTORY.uri,
					`${item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item)}.filenmeta`
				)
			)
		}
	}

	public async has(item: CacheItem): Promise<boolean> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			return false
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const { audio, metadata } = this.getFiles(item)

			if (!audio.exists || !metadata.exists || metadata.size === 0) {
				return false
			}

			const metadataContent = parseMetadata(await metadata.text())

			if (!hasMetadata(metadataContent)) {
				return false
			}

			return true
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async getMetadata({ item, signal }: { item: CacheItem; signal?: AbortSignal }): Promise<Metadata> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		return (
			await this.get({
				item,
				signal
			})
		).metadata
	}

	public async get({ item, signal }: { item: CacheItem; signal?: AbortSignal }): Promise<{
		audio: FileSystem.File
		metadata: Metadata
	}> {
		const result = await run(async defer => {
			if (
				item.type === "drive" &&
				item.data.type !== "file" &&
				item.data.type !== "sharedFile" &&
				item.data.type !== "sharedRootFile"
			) {
				throw new Error("Item must be a file or shared file")
			}

			const name = item.type === "drive" ? item.data.data.decryptedMeta?.name : item.data.name
			const mime = mimeTypes.lookup(name ?? "")

			if (!name) {
				throw new Error("Item metadata is not decrypted")
			}

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { audio, metadata: metadataFile } = this.getFiles(item)

			if (audio.exists && metadataFile.exists && metadataFile.size > 0) {
				try {
					const metadata = parseMetadata(await metadataFile.text())

					if (hasMetadata(metadata)) {
						return {
							audio,
							metadata
						}
					}
				} catch (e) {
					console.error(e)

					if (metadataFile.exists) {
						metadataFile.delete()
					}
				}
			}

			const audioFile = await fileCache.get({
				item,
				signal
			})

			let metadata: Metadata = null

			if (MUSIC_METADATA_SUPPORTED_EXTENSIONS.has(FileSystem.Paths.extname(name).toLowerCase().trim())) {
				try {
					if ((!metadataFile.exists || metadataFile.size === 0) && !audioFileTooLargeToParse(audioFile.size)) {
						if (!audioFile.exists) {
							throw new Error("Audio file does not exist after download")
						}

						// Serialize parses across items so concurrent fetches don't pile parseWebStream's
						// JS-thread work on at once. Held until get() returns (released by the deferred below).
						await this.parseSemaphore.acquire()

						defer(() => {
							this.parseSemaphore.release()
						})

						const parsedMetadata = await parseWebStream(audioFile.stream(), {
							mimeType: mime ? mime : undefined,
							size: audioFile.size
						})

						const picture = parsedMetadata?.common?.picture?.at(0)
						let pictureUri: string | null = null
						let pictureBlurhash: string | null = null

						if (picture) {
							const cacheId = item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item)
							const ext = mimeTypes.extension(picture.format) || "jpg"
							const pictureFile = new FileSystem.File(FileSystem.Paths.join(PARENT_DIRECTORY.uri, `${cacheId}.${ext}`))

							if (pictureFile.exists) {
								pictureFile.delete()
							}

							pictureFile.create({
								intermediates: true
							})

							pictureFile.write(picture.data)

							pictureUri = pictureFile.uri

							let image: ImageRef | null = null

							try {
								image = await Image.loadAsync(pictureFile.uri)
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
							pictureUri,
							pictureBlurhash,
							artist: parsedMetadata.common?.artist ?? null,
							title: parsedMetadata.common?.title ?? null,
							album: parsedMetadata.common?.album ?? null,
							date: parsedMetadata.common?.date ?? null,
							duration: parsedMetadata.format?.duration ? Math.round(parsedMetadata.format.duration) : null,
							cachedAt: Date.now()
						}

						// Atomic sidecar write (temp + single overwriting move): a crash mid-write
						// can no longer leave a torn sidecar that has()/get() choke on. Ensure the
						// parent directory first — atomicWrite's move does not create intermediates
						// (the old create({ intermediates: true }) covered that).
						this.ensureDirectory()

						atomicWrite(metadataFile, serialize(metadata))

						this.scheduleGc()
					} else if (metadataFile.exists && metadataFile.size > 0) {
						metadata = parseMetadata(await metadataFile.text())

						if (!hasMetadata(metadata)) {
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

	public async remove(item: CacheItem): Promise<void> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { metadata: metadataFile } = this.getFiles(item)

			if (metadataFile.exists) {
				const parseResult = await run(async () => {
					return parseMetadata(await metadataFile.text())
				})

				if (parseResult.success && parseResult.data?.pictureUri) {
					const pictureFile = new FileSystem.File(parseResult.data.pictureUri)

					if (pictureFile.exists) {
						pictureFile.delete()
					}
				}

				metadataFile.delete()
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async gc(age?: number): Promise<void> {
		if (!PARENT_DIRECTORY.exists) {
			return
		}

		const now = Date.now()
		const entries = PARENT_DIRECTORY.list()

		// Pass 1: gc expired or corrupt sidecars and their owning picture files.
		await Promise.all(
			entries.map(async entry => {
				await run(async defer => {
					if (!(entry instanceof FileSystem.File)) {
						return
					}

					if (!entry.name.endsWith(".filenmeta")) {
						return
					}

					let shouldDelete = false
					let pictureUri: string | null = null

					const parseResult = await run(async () => {
						const metadata = parseMetadata(await entry.text())

						pictureUri = metadata?.pictureUri ?? null

						return !hasMetadata(metadata) || now >= (metadata?.cachedAt ?? 0) + (age ?? 86400 * 1000)
					})

					if (parseResult.success) {
						shouldDelete = parseResult.data
					} else {
						// A corrupted sidecar is a deletion candidate too.
						shouldDelete = true
					}

					if (!shouldDelete) {
						return
					}

					const mutex = this.getMutexForKey(entry.name.replace(".filenmeta", ""))

					await mutex.acquire()

					defer(() => {
						mutex.release()
					})

					// Re-check inside the mutex. A concurrent get() may have just finished
					// writing a fresh sidecar for this key — Pass 1's initial parse ran
					// without the mutex held. Refresh pictureUri at the same time so we
					// never delete a picture that belongs to fresh metadata.
					if (!entry.exists) {
						return
					}

					const recheck = await run(async () => {
						const metadata = parseMetadata(await entry.text())

						pictureUri = metadata?.pictureUri ?? null

						return !hasMetadata(metadata) || now >= (metadata?.cachedAt ?? 0) + (age ?? 86400 * 1000)
					})

					if (recheck.success && !recheck.data) {
						return
					}

					if (pictureUri) {
						const pictureFile = new FileSystem.File(pictureUri)

						if (pictureFile.exists) {
							pictureFile.delete()
						}
					}

					if (entry.exists) {
						entry.delete()
					}
				})
			})
		)

		// Pass 2: sweep orphaned picture files — pictures whose sidecar no longer
		// exists. get() writes the picture before the sidecar, so an aborted or
		// crashed run can leave the picture stranded; pass 1's sidecar deletes can
		// also leave behind a picture if the sidecar's pictureUri was missing.
		await Promise.all(
			entries.map(async entry => {
				await run(async defer => {
					if (!(entry instanceof FileSystem.File)) {
						return
					}

					if (entry.name.endsWith(".filenmeta")) {
						return
					}

					const dotIndex = entry.name.lastIndexOf(".")
					const cacheId = dotIndex === -1 ? entry.name : entry.name.substring(0, dotIndex)

					if (!cacheId) {
						return
					}

					const sidecar = new FileSystem.File(FileSystem.Paths.join(PARENT_DIRECTORY.uri, `${cacheId}.filenmeta`))

					if (sidecar.exists) {
						return
					}

					// Block against a concurrent get() racing to write a fresh sidecar
					// for this key. After the mutex is held, re-check the sidecar so a
					// just-finished get() isn't undone.
					const mutex = this.getMutexForKey(cacheId)

					await mutex.acquire()

					defer(() => {
						mutex.release()
					})

					if (sidecar.exists) {
						return
					}

					if (entry.exists) {
						entry.delete()
					}
				})
			})
		)
	}

	public async clear(): Promise<void> {
		await this.clearBarrier.runExclusive(() => {
			if (PARENT_DIRECTORY.exists) {
				PARENT_DIRECTORY.delete()
			}

			PARENT_DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		})
	}

	public size(): number {
		if (!PARENT_DIRECTORY.exists) {
			return 0
		}

		let total = 0

		for (const entry of PARENT_DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.File)) {
				continue
			}

			total += entry.size ?? 0
		}

		return total
	}
}

const audioCache = new AudioCache()

export default audioCache
