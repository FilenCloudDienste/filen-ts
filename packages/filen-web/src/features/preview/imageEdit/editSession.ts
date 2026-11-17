import { driveItemName, nameCollisionKey } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { extensionOf, heldImageCap, imageDecodeFor } from "@/features/drive/lib/preview.logic"
import { HEIC_EXTENSIONS } from "@/features/preview/lib/imageFormat"
import { narrowToAnyFile } from "@/features/drive/lib/download"
import { driveListingQueryOptions } from "@/features/drive/queries/drive"
import { decodeHeicRgba, decodeRasterRgba, RASTER_BYTES_PER_PIXEL } from "@/features/preview/lib/rasterDecode"
import { getPreviewBytes, loadPreviewBytes } from "@/features/preview/lib/previewCache"
import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"
import { saveTargets } from "@/features/preview/imageEdit/lib/targets"
import { heifExif, heifIcc } from "@/features/preview/imageEdit/lib/heifMeta"
import { openEditSession } from "@/features/preview/imageEdit/renderClient"
import type { EditCapabilities, EditSession, ImageEditSource, SaveTarget, SourceInfo, SourceMime } from "@/features/preview/imageEdit/types"
import { queryClient } from "@/queries/client"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import type { PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"
import { deviceProfile } from "@/lib/deviceProfile"
import { workerDecodePixels } from "@/lib/pixelBudget"
import type { ByteOrigin } from "@/lib/sdk/byteOrigin"
import { mupdfImagePixels, openMupdfReader } from "@/lib/mupdf/reader"
import { readerPageSource, type ImagePageSource } from "@/features/preview/lib/imagePageSource"
import { anyTranslucent } from "@/features/preview/lib/rasterCodecs/raster"

// Entering the image editor: what the original is (sniffed from its own bytes, never its name), whether this device
// can edit it, and where the editor gets its full-resolution pixels, reusing whatever the viewer already holds.

// The most of a file read to sniff it when its bytes are not held: every header the sniffers walk fits.
const SNIFF_HEAD_BYTES = 1024 * 1024

export interface ImageEditState {
	// The pager slot (its frozen uuid) and the version (its uuid) the session edits: either changing ends it.
	frozenUuid: string
	uuid: string
	source: ImageEditSource
	info: SourceInfo
	session: EditSession
	capabilities: EditCapabilities
	targets: { primary: SaveTarget; copy: SaveTarget }
	// The slot showed the file from its held bytes: a save keeps what it uploads there, so the saved version
	// reopens without a download. A streamed slot streams the saved version as well.
	buffered: boolean
	// The source is one page of several (a TIFF's): the copy holds that page alone.
	pageOnly: boolean
	// Ends the session (once, however often called) and frees a bitmap the editor never took.
	release(): void
}

export type EnterImageEditOutcome =
	{ status: "ready"; state: ImageEditState } | { status: "refused"; messageKey: PreviewKey } | { status: "cancelled" }

// The sniffed format each image extension names; a file whose bytes say another is not edited (its save would
// write one format under a name that says another).
const EXTENSION_FAMILY: ReadonlyMap<string, SourceMime> = new Map<string, SourceMime>([
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["jfif", "image/jpeg"],
	["jpe", "image/jpeg"],
	["pjpeg", "image/jpeg"],
	["pjp", "image/jpeg"],
	["png", "image/png"],
	["apng", "image/png"],
	["webp", "image/webp"],
	["gif", "image/gif"],
	["bmp", "image/bmp"],
	["ico", "image/x-icon"],
	["avif", "image/avif"],
	["qoi", "image/x-qoi"],
	["jxl", "image/jxl"],
	["tif", "image/tiff"],
	["tiff", "image/tiff"],
	...[...HEIC_EXTENSIONS].map(extension => [extension, "image/heic"] as const)
])

// The formats whose editing source our own code decodes from the whole file, or ("mupdf") a document engine draws.
type EditDecoder = "heic" | "qoi" | "jxl" | "mupdf"

function editDecoder(item: DriveItem): EditDecoder | null {
	const decode = imageDecodeFor(item)

	return decode === "heic" || decode === "qoi" || decode === "jxl" || decode === "mupdf" ? decode : null
}

export function matchesExtension(name: string, mime: SourceMime): boolean {
	return EXTENSION_FAMILY.get(extensionOf(name)) === mime
}

// The names taken in a directory, as the server compares them: one read of its listing (the cached one while it is
// current), for naming a copy.
export async function takenNames(parent: string | null): Promise<ReadonlySet<string>> {
	const listing = await queryClient.query(driveListingQueryOptions("drive", parent))

	return new Set(listing.map(row => nameCollisionKey(driveItemName(row))))
}

// A read under `token` that stops when `signal` aborts.
function cancellable<T>(signal: AbortSignal, read: (token: string) => Promise<T>): Promise<T> {
	const token = crypto.randomUUID()
	const cancel = (): void => {
		void sdkApi.cancelPreviewDownload(token)
	}

	signal.addEventListener("abort", cancel, { once: true })

	return read(token).finally(() => {
		signal.removeEventListener("abort", cancel)
	})
}

// The whole file, shared with (and kept for) the preview as its own load would be.
function wholeBytes(item: DriveItem, cacheScope: string | null, signal: AbortSignal): Promise<Uint8Array> {
	const file = narrowToAnyFile(item)

	return loadPreviewBytes(
		cacheScope,
		item.data.uuid,
		Number(file.size),
		() => cancellable(signal, token => runOp(sdkApi.downloadFileBytes(file, token))),
		{ signal }
	)
}

function headBytes(item: DriveItem, signal: AbortSignal): Promise<Uint8Array> {
	const file = narrowToAnyFile(item)

	return cancellable(signal, token => runOp(sdkApi.readFileBytesRange(file, 0, Math.min(Number(file.size), SNIFF_HEAD_BYTES), token)))
}

// The viewer's decoded <img>, as a bitmap of the pixels as stored: no colour conversion (the editor works in the
// source's own space and carries its profile), orientation applied (the sniffed size is upright), alpha
// unpremultiplied. Null when the element has nothing decoded to give.
async function bitmapOf(image: HTMLImageElement | null): Promise<ImageBitmap | null> {
	if (image === null || !image.complete || image.naturalWidth === 0) {
		return null
	}

	await image.decode()

	return await createImageBitmap(image, { colorSpaceConversion: "none", imageOrientation: "from-image", premultiplyAlpha: "none" })
}

function heldBlob(bytes: Uint8Array, mime: SourceMime): Blob {
	return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })
}

async function sourceFor(
	item: DriveItem,
	info: SourceInfo,
	held: Uint8Array | undefined,
	image: HTMLImageElement | null,
	cacheScope: string | null,
	signal: AbortSignal
): Promise<{ source: ImageEditSource; info: SourceInfo; buffered: boolean }> {
	if (held !== undefined) {
		return { source: { kind: "blob", blob: heldBlob(held, info.mime) }, info, buffered: true }
	}

	// Never a picture shown at another size than its own.
	const whole = image !== null && image.naturalWidth === info.width && image.naturalHeight === info.height
	const bitmap = await bitmapOf(whole ? image : null).catch((e: unknown) => {
		log.warn("image-edit", "taking the shown image's pixels failed; reading the file instead", e)

		return null
	})

	if (bitmap !== null) {
		return { source: { kind: "bitmap", bitmap }, info, buffered: false }
	}

	const bytes = await wholeBytes(item, cacheScope, signal)

	return { source: { kind: "blob", blob: heldBlob(bytes, info.mime) }, info, buffered: true }
}

async function heicSource(
	bytes: Uint8Array,
	info: SourceInfo,
	signal: AbortSignal
): Promise<{ source: ImageEditSource; info: SourceInfo }> {
	const decoded = await decodeHeicRgba(bytes, signal)

	return {
		source: { kind: "rgba", width: decoded.width, height: decoded.height, data: decoded.data },
		info: {
			...info,
			width: decoded.width,
			height: decoded.height,
			hasAlpha: decoded.hasAlpha,
			exif: heifExif(bytes),
			icc: heifIcc(bytes)
		}
	}
}

// The engine's page drawn whole at its own resolution, from the viewer's engine (the page it shows) or, before that one
// is open, from an engine of its own on the file's first page. Refused when the page is larger than the editor takes.
async function pageSourced(
	item: DriveItem,
	info: SourceInfo,
	shown: ImagePageSource | null,
	maxPixels: number,
	cacheScope: string | null,
	signal: AbortSignal
): Promise<{ source: ImageEditSource; info: SourceInfo; pageOnly: boolean } | null> {
	if (shown !== null) {
		return await drawPage(shown, info, maxPixels, signal)
	}

	const origin: ByteOrigin = { kind: "file", file: narrowToAnyFile(item) }
	const reader = await openMupdfReader({
		origin,
		access: "authed",
		scope: cacheScope,
		format: "tiff",
		maxImagePixels: mupdfImagePixels(deviceProfile(), origin, "tiff"),
		signal
	})

	try {
		return await drawPage(readerPageSource(reader, 0), info, maxPixels, signal)
	} finally {
		await reader.close()
	}
}

async function drawPage(
	page: ImagePageSource,
	info: SourceInfo,
	maxPixels: number,
	signal: AbortSignal
): Promise<{ source: ImageEditSource; info: SourceInfo; pageOnly: boolean } | null> {
	const extent = await page.extent()

	if (extent !== null && extent.width * extent.height > maxPixels) {
		return null
	}

	const drawn = await page.renderRgba(maxPixels, signal)

	return {
		source: { kind: "rgba", width: drawn.width, height: drawn.height, data: drawn.rgba },
		info: { ...info, width: drawn.width, height: drawn.height, orientation: 1, hasAlpha: anyTranslucent(drawn.rgba) },
		pageOnly: page.pageCount > 1
	}
}

// The full-resolution RGBA a decoder of our own makes from the whole file.
async function decodedSource(
	decoder: Exclude<EditDecoder, "mupdf">,
	bytes: Uint8Array,
	info: SourceInfo,
	signal: AbortSignal
): Promise<{ source: ImageEditSource; info: SourceInfo }> {
	if (decoder === "heic") {
		return await heicSource(bytes, info, signal)
	}

	const maxPixels = workerDecodePixels(deviceProfile(), bytes.byteLength, RASTER_BYTES_PER_PIXEL[decoder])
	const decoded = await decodeRasterRgba(decoder, bytes, maxPixels, signal)

	return {
		source: { kind: "rgba", width: decoded.width, height: decoded.height, data: decoded.data },
		info: { ...info, width: decoded.width, height: decoded.height, hasAlpha: decoded.hasAlpha }
	}
}

async function enter(
	item: DriveItem,
	frozenUuid: string,
	cacheScope: string | null,
	image: HTMLImageElement | null,
	page: ImagePageSource | null,
	signal: AbortSignal
): Promise<EnterImageEditOutcome> {
	const name = driveItemName(item)
	const size = Number(narrowToAnyFile(item).size)
	// Decoded by our own code from its whole bytes on every browser, also where the viewer streams it natively: a HEIC's
	// Exif and ICC only the bytes give. A JPEG XL the browser shows itself gives its <img>'s pixels instead, as any
	// native image does.
	const shownNatively = imageDecodeFor(item) === "jxl" && image !== null && image.complete && image.naturalWidth > 0
	const decoder = shownNatively ? null : editDecoder(item)
	// A document engine's page is drawn by the engine: the file is not held here.
	const fromBytes = decoder !== null && decoder !== "mupdf"
	const cached = getPreviewBytes(cacheScope, item.data.uuid)
	// Where the viewer streams a HEIC natively it opens at any size: one past what is ever held is refused before its
	// download, never buffered.
	const cap = fromBytes && cached === undefined ? heldImageCap(item, deviceProfile()) : null

	if (cap !== null && BigInt(size) > cap) {
		return { status: "refused", messageKey: "previewImageSaveRefusedTooLarge" }
	}

	let held = cached ?? (fromBytes ? await wholeBytes(item, cacheScope, signal) : undefined)
	let info = sniffImage(held ?? (await headBytes(item, signal)), size)

	if (info === null || !matchesExtension(name, info.mime)) {
		return { status: "refused", messageKey: "previewImageSaveRefusedUnsupported" }
	}

	if (info.animated) {
		return { status: "refused", messageKey: "previewImageSaveRefusedAnimated" }
	}

	// A WebP whose Exif follows its image data: read whole, which the editor then decodes from too.
	if (info.needsTail && held === undefined) {
		held = await wholeBytes(item, cacheScope, signal)
		info = sniffImage(held, size) ?? info
	}

	const opened = await openEditSession()

	// Whatever goes wrong from here closes the session, which would otherwise hold the worker.
	return await prepare(item, frozenUuid, info, held, decoder, opened, cacheScope, image, page, signal).catch((e: unknown) => {
		opened.session.close()

		throw e
	})
}

async function prepare(
	item: DriveItem,
	frozenUuid: string,
	info: SourceInfo,
	held: Uint8Array | undefined,
	decoder: EditDecoder | null,
	opened: { session: EditSession; capabilities: EditCapabilities },
	cacheScope: string | null,
	image: HTMLImageElement | null,
	page: ImagePageSource | null,
	signal: AbortSignal
): Promise<EnterImageEditOutcome> {
	const refuse = (messageKey: PreviewKey): EnterImageEditOutcome => {
		opened.session.close()

		return { status: "refused", messageKey }
	}

	if (!opened.capabilities.webgl2) {
		return refuse("previewImageSaveRefusedNoGraphics")
	}

	// A document engine's page is checked by its own extent: the header sniffed is the first page's.
	if (decoder !== "mupdf" && info.width * info.height > opened.capabilities.maxPixels) {
		return refuse("previewImageSaveRefusedTooLarge")
	}

	let prepared: { source: ImageEditSource; info: SourceInfo; buffered: boolean; pageOnly: boolean }

	if (decoder === "mupdf") {
		const drawn = await pageSourced(item, info, page, opened.capabilities.maxPixels, cacheScope, signal)

		if (drawn === null) {
			return refuse("previewImageSaveRefusedTooLarge")
		}

		prepared = { ...drawn, buffered: false }
	} else {
		prepared = {
			...(decoder !== null && held !== undefined
				? { ...(await decodedSource(decoder, held, info, signal)), buffered: true }
				: await sourceFor(item, info, held, image, cacheScope, signal)),
			pageOnly: false
		}
	}

	if (signal.aborted) {
		opened.session.close()

		if (prepared.source.kind === "bitmap") {
			prepared.source.bitmap.close()
		}

		return { status: "cancelled" }
	}

	const source = prepared.source
	let released = false

	return {
		status: "ready",
		state: {
			frozenUuid,
			uuid: item.data.uuid,
			source,
			info: prepared.info,
			session: opened.session,
			capabilities: opened.capabilities,
			targets: saveTargets(prepared.info, opened.capabilities.canEncodeWebp),
			buffered: prepared.buffered,
			pageOnly: prepared.pageOnly,
			release: () => {
				if (released) {
					return
				}

				released = true
				opened.session.close()

				// A no-op once the bitmap went to the worker.
				if (source.kind === "bitmap") {
					source.bitmap.close()
				}
			}
		}
	}
}

// Everything the editor needs to open `item` (shown in the slot `frozenUuid`), or why it cannot. `image`: the
// viewer's <img>, whose decoded pixels are taken rather than fetching the file again; `page`: the page a document
// engine shows (a TIFF's), drawn by that engine. Never rejects.
export async function enterImageEdit(args: {
	item: DriveItem
	frozenUuid: string
	cacheScope: string | null
	image: HTMLImageElement | null
	page?: ImagePageSource | null
	signal: AbortSignal
}): Promise<EnterImageEditOutcome> {
	return await enter(args.item, args.frozenUuid, args.cacheScope, args.image, args.page ?? null, args.signal).catch((e: unknown) => {
		if (args.signal.aborted) {
			return { status: "cancelled" as const }
		}

		log.error("image-edit", "opening the image for editing failed", e)

		return { status: "refused" as const, messageKey: "previewImageSaveOpenFailed" as const }
	})
}
