import * as FileSystem from "expo-file-system"
import { fileTypeExtension } from "@/lib/previewType"
import { Semaphore, run, runOrThrow, normalizeTrackTags } from "@filen/shared"
import { DiskCache, cacheItemId, gcIdleUntil, planGcCapEviction, type GcSurvivor } from "@/lib/diskCache"
import { MUSIC_METADATA_SUPPORTED_EXTENSIONS, AUDIO_METADATA_MAX_PARSE_SIZE_BYTES, AUDIO_METADATA_MAX_CONCURRENT_PARSES } from "@/constants"
import { serialize, deserialize } from "@/lib/serializer"
import { atomicWrite } from "@/lib/fsAtomic"
import fileCache from "@/lib/fileCache"
import { Image, type ImageRef } from "expo-image"
import type { CacheItem } from "@/types"
import { AUDIO_CACHE_PARENT_DIRECTORY } from "@/lib/storageRoots"
import { META_FILE_SUFFIX, metaFileName } from "@/lib/metaFile"
import { CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import { GC_AGE_MS, GC_CONCURRENCY } from "@/lib/cacheGc"
import logger from "@/lib/logger"
import { isFileItem } from "@/features/drive/driveSelectors"
import { loadMimeTypes } from "@/lib/utils"

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

// Changing the storage index/persistence format requires bumping AUDIO_CACHE_VERSION in storageRoots.ts.
const PARENT_DIRECTORY = AUDIO_CACHE_PARENT_DIRECTORY

function parseMetadata(raw: string): Metadata {
	const result = deserialize<unknown>(raw)

	return typeof result === "object" && result !== null && typeof (result as { cachedAt?: unknown }).cachedAt === "number"
		? (result as Metadata)
		: null
}

function hasMetadata(m: Metadata): m is NonNullable<Metadata> {
	return m !== null && Object.keys(m).length > 0
}

// Tags are immutable per uuid, so a parsed result only needs refetching once its cover file is gone.
// null is not servable: get() also returns null after swallowed transient parse/IO failures, which must keep retrying.
export function isMetadataServable(data: Metadata | undefined): boolean {
	return !!data && (!data.pictureUri || new FileSystem.File(data.pictureUri).exists)
}

function isExpired(metadata: Metadata, now: number, ttlMs: number): boolean {
	return !hasMetadata(metadata) || now >= metadata.cachedAt + ttlMs
}

function sidecarFile(cacheId: string): FileSystem.File {
	return new FileSystem.File(FileSystem.Paths.join(PARENT_DIRECTORY.uri, metaFileName(cacheId)))
}

function deletePictureAt(uri: string): void {
	const pictureFile = new FileSystem.File(uri)

	if (pictureFile.exists) {
		pictureFile.delete()
	}
}

// music-metadata's `parseWebStream` runs on the JS thread; for large inputs it can visibly
// degrade JS-thread performance (headerless-VBR duration scans, large embedded cover art,
// general stream/parse overhead). Skip parsing a file whose size is KNOWN to exceed the cap —
// the track still plays, it just has no cached cover/tags. An unknown size (rare for a
// downloaded file) falls through and parses as before, so this never regresses that case.
function audioFileTooLargeToParse(sizeBytes: number | null | undefined): boolean {
	return typeof sizeBytes === "number" && sizeBytes > AUDIO_METADATA_MAX_PARSE_SIZE_BYTES
}

export class AudioCache extends DiskCache {
	// Global gate so concurrent metadata fetches across different items don't pile
	// parseWebStream's JS-thread work on at once (Hermes is single-threaded — see
	// AUDIO_METADATA_MAX_CONCURRENT_PARSES). The per-key mutex below only serializes
	// the SAME item; this bounds parses across ALL items.
	private readonly parseSemaphore = new Semaphore(AUDIO_METADATA_MAX_CONCURRENT_PARSES)

	public constructor() {
		super(PARENT_DIRECTORY, "audioCache")
	}

	public getFiles(item: CacheItem): {
		audio: FileSystem.File
		metadata: FileSystem.File
	} {
		// Handle derivation only — the actual audio bytes are written by fileCache.get()
		// (which ensures its own directory), so a metadata peek must not create one.
		const { file: dataFile } = fileCache.getFiles(item, { ensureParentDirectory: false })

		return {
			audio: dataFile,
			metadata: sidecarFile(cacheItemId(item))
		}
	}

	public async getMetadata({ item, signal }: { item: CacheItem; signal?: AbortSignal }): Promise<Metadata> {
		if (item.type === "drive" && !isFileItem(item.data)) {
			throw new Error("Item must be a file or shared file")
		}

		// AU-08: metadata-only fast path. The metadata sidecar (tiny) and the audio BYTES (large,
		// in fileCache under its own 250MB cap) evict INDEPENDENTLY, so the steady state is "sidecar
		// present, bytes gone". Return a valid sidecar WITHOUT requiring the bytes and WITHOUT falling
		// through to get() -> fileCache.get() (a full re-download) just to render a title/cover. Only a
		// missing / empty / corrupt / no-metadata sidecar falls back to the full get() (download + parse).
		const cached = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const { metadata: metadataFile } = this.getFiles(item)

			if (!metadataFile.exists || metadataFile.size === 0) {
				return undefined
			}

			try {
				const metadata = parseMetadata(await metadataFile.text())

				if (hasMetadata(metadata)) {
					return metadata
				}
			} catch (e) {
				logger.warn("audioCache", "metadata-only sidecar read failed; falling back to full get", {
					uuid: cacheItemId(item),
					error: e
				})
			}

			return undefined
		})

		if (cached.success && cached.data !== undefined) {
			return cached.data
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
		return await runOrThrow(async defer => {
			if (item.type === "drive" && !isFileItem(item.data)) {
				throw new Error("Item must be a file or shared file")
			}

			const name = item.type === "drive" ? item.data.data.decryptedMeta?.name : item.data.name

			if (!name) {
				throw new Error("Item metadata is not decrypted")
			}

			const cacheId = cacheItemId(item)

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			defer(await this.keyMutexes.acquire(cacheId))

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
					logger.error("audioCache", "corrupt metadata sidecar deleted", {
						uuid: cacheId,
						error: e
					})

					if (metadataFile.exists) {
						metadataFile.delete()
					}
				}
			}

			// Covers the corrupt-sidecar delete above (same synchronous run); the deferred bump covers the
			// picture and sidecar writes (and the failure-path sidecar delete) that land after the download.
			this.noteWrite()

			defer(() => {
				this.noteWrite()
			})

			const audioFile = await fileCache.get({
				item,
				signal
			})

			let metadata: Metadata = null

			// The type extension the preview reads, so a track typed only by its stored mime still gets its tags.
			const typeExtension = fileTypeExtension(
				name,
				item.type === "drive" && isFileItem(item.data) ? item.data.data.decryptedMeta?.mime : undefined
			)

			if (MUSIC_METADATA_SUPPORTED_EXTENSIONS.has(`.${typeExtension}`)) {
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

						// Loaded on first parse: both are only needed here, and cache hits never reach it.
						const [{ parseWebStream }, mimeTypes] = await Promise.all([import("music-metadata"), loadMimeTypes()])
						const mime = mimeTypes.lookup(typeExtension)

						const parsedMetadata = await parseWebStream(audioFile.stream(), {
							mimeType: mime ? mime : undefined,
							size: audioFile.size
						})

						const picture = parsedMetadata?.common?.picture?.at(0)
						let pictureUri: string | null = null
						let pictureBlurhash: string | null = null

						if (picture) {
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
								logger.warn("audioCache", "blurhash generation failed for cover art", {
									uuid: cacheId,
									error: e
								})
							} finally {
								if (image) {
									image.release()

									image = null
								}
							}
						}

						const tags = normalizeTrackTags(parsedMetadata)

						metadata = {
							pictureUri,
							pictureBlurhash,
							artist: tags.artist,
							title: tags.title,
							album: tags.album,
							date: tags.date,
							duration: tags.durationSec,
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
					logger.error("audioCache", "audio metadata parse or sidecar write failed", {
						uuid: cacheId,
						error: e
					})

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
	}

	protected async runGc(age?: number): Promise<number | null> {
		const now = Date.now()
		const ttlMs = age ?? GC_AGE_MS
		const entries = PARENT_DIRECTORY.list()
		const survivors: GcSurvivor[] = []
		let hadCandidates = false
		// AU-09: shared cap across all three passes (created per gc run).
		const gcSemaphore = new Semaphore(GC_CONCURRENCY)

		// Pass 1: gc expired or corrupt sidecars and their owning picture files; collect
		// the survivors (footprint + cachedAt) for the size-cap pass below.
		await Promise.all(
			entries.map(async entry => {
				await run(async defer => {
					if (!(entry instanceof FileSystem.File)) {
						return
					}

					if (!entry.name.endsWith(META_FILE_SUFFIX)) {
						return
					}

					// AU-09: bound the fan-out — acquire after the cheap sync filters, before any FS work.
					// Deferred first so it releases LAST (LIFO), after the per-key mutex acquired below.
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					const cacheId = entry.name.replace(META_FILE_SUFFIX, "")
					let shouldDelete = false
					let pictureUri: string | null = null
					let cachedAt = 0

					const parseResult = await run(async () => {
						const metadata = parseMetadata(await entry.text())

						pictureUri = metadata?.pictureUri ?? null
						cachedAt = metadata?.cachedAt ?? 0

						return isExpired(metadata, now, ttlMs)
					})

					if (parseResult.success) {
						shouldDelete = parseResult.data
					} else {
						// A corrupted sidecar is a deletion candidate too.
						shouldDelete = true
					}

					if (shouldDelete) {
						hadCandidates = true
					}

					if (!shouldDelete) {
						// Survivor — record its footprint (sidecar + owning picture) for the cap pass.
						let size = entry.size ?? 0

						if (pictureUri) {
							const pictureFile = new FileSystem.File(pictureUri)

							if (pictureFile.exists) {
								size += pictureFile.size ?? 0
							}
						}

						survivors.push({
							key: cacheId,
							cachedAt,
							size
						})

						return
					}

					defer(await this.keyMutexes.acquire(cacheId))

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

						return isExpired(metadata, now, ttlMs)
					})

					if (recheck.success && !recheck.data) {
						return
					}

					if (pictureUri) {
						deletePictureAt(pictureUri)
					}

					if (entry.exists) {
						entry.delete()
					}
				})
			})
		)

		// Pass 1.5: soft size-cap eviction over the survivors (sidecars and their pictures).
		const { evict: capEvict, plannedCachedAt: capCachedAt } = planGcCapEviction(survivors, CACHE_MAX_SIZE_BYTES)

		if (capEvict.length > 0) {
			hadCandidates = true
		}

		await Promise.all(
			capEvict.map(async cacheId => {
				await run(async defer => {
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					defer(await this.keyMutexes.acquire(cacheId))

					const sidecar = sidecarFile(cacheId)

					if (!sidecar.exists) {
						return
					}

					const plannedCachedAt = capCachedAt.get(cacheId)
					let pictureUri: string | null = null

					const recheck = await run(async () => {
						const metadata = parseMetadata(await sidecar.text())

						pictureUri = metadata?.pictureUri ?? null

						// Only evict if untouched since planning — a refresh makes it the newest.
						return hasMetadata(metadata) && metadata.cachedAt === plannedCachedAt
					})

					if (!recheck.success || !recheck.data) {
						return
					}

					if (pictureUri) {
						deletePictureAt(pictureUri)
					}

					if (sidecar.exists) {
						sidecar.delete()
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

					if (entry.name.endsWith(META_FILE_SUFFIX)) {
						return
					}

					const dotIndex = entry.name.lastIndexOf(".")
					const cacheId = dotIndex === -1 ? entry.name : entry.name.substring(0, dotIndex)

					if (!cacheId) {
						return
					}

					const sidecar = sidecarFile(cacheId)

					if (sidecar.exists) {
						return
					}

					hadCandidates = true

					// Block against a concurrent get() racing to write a fresh sidecar
					// for this key. After the mutex is held, re-check the sidecar so a
					// just-finished get() isn't undone.
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					defer(await this.keyMutexes.acquire(cacheId))

					if (sidecar.exists) {
						return
					}

					if (entry.exists) {
						entry.delete()
					}
				})
			})
		)

		return gcIdleUntil(hadCandidates, survivors, ttlMs)
	}
}

const audioCache = new AudioCache()

export default audioCache
