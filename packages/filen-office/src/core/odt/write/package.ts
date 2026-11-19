import { bytesSource, planZip, writeZip, type ByteSink, type PartBytes, type PartChange, ZipError } from "../../opc/index"
import { metaOnSave } from "../../odf/meta"
import { OdfPackage } from "../../odf/index"
import { type RtfJob } from "../../rtf/turns"
import { assertWellFormed, decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { nativeDeflate, nativeDeflateChunks } from "../../docx/write/zip"
import { esc } from "../wml"
import { OdtWriteRefusal } from "./emit"
import type { OdtSource } from "./source"

// Writing the package: content.xml and styles.xml replaced, every other entry copied as stored.

const PICTURE_TYPES: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp",
	svg: "image/svg+xml",
	tif: "image/tiff",
	tiff: "image/tiff",
	emf: "image/x-emf",
	wmf: "image/x-wmf"
}

// A sink writing into one buffer (grown when it must be): the written package is never held twice.
function bufferSink(size: number): ByteSink & { bytes(): Uint8Array } {
	let buffer = new Uint8Array(Math.max(1024, Math.ceil(size)))
	let length = 0

	return {
		write(chunk) {
			if (length + chunk.length > buffer.length) {
				const grown = new Uint8Array(Math.max(length + chunk.length, Math.ceil(buffer.length * 1.25)))

				grown.set(buffer.subarray(0, length))
				buffer = grown
			}

			buffer.set(chunk, length)
			length += chunk.length

			return Promise.resolve()
		},
		close() {
			return Promise.resolve()
		},
		bytes: () => buffer.subarray(0, length)
	}
}

// The preview image (Part 2 §3.8): a picture of the first page, which an edit may change and the writer cannot draw.
export const THUMBNAIL = "Thumbnails/thumbnail.png"
export const META = "meta.xml"

// The source's meta.xml as a save at `date` leaves it (metaOnSave); undefined: copied as it is (none, or it does not
// read).
export async function savedMeta(source: OdtSource, date: string): Promise<Uint8Array | undefined> {
	const entry = source.archive.get(META)

	if (entry === undefined) return undefined

	try {
		return metaOnSave(await source.archive.read(entry), date)
	} catch (error) {
		if (error instanceof ZipError) return undefined

		throw error
	}
}

// The package with content.xml (and styles.xml, meta.xml) replaced; every other entry copied as stored, mimetype
// first. A preview image goes: Part 2 §3.8 says a producer should make one of the first page, never that a stale one
// may stay. The manifest as written (undefined: the source's, copied).
export async function writePackage(
	source: OdtSource,
	content: PartBytes,
	styles: PartBytes | undefined,
	meta: Uint8Array | undefined,
	pictures: ReadonlyMap<string, Uint8Array>,
	job: RtfJob | undefined
): Promise<{ readonly bytes: Uint8Array; readonly manifest: Uint8Array | undefined }> {
	const replace: PartChange[] = [{ name: "content.xml", bytes: content }]
	const add: PartChange[] = []
	const remove: string[] = []
	const thumbnail = source.archive.get(THUMBNAIL) !== undefined
	let written: Uint8Array | undefined

	if (styles !== undefined) replace.push({ name: "styles.xml", bytes: styles })
	if (meta !== undefined) replace.push({ name: META, bytes: meta })
	if (thumbnail) remove.push(THUMBNAIL)

	if (pictures.size > 0 || thumbnail) {
		// New pictures as entries of their own (stored: they are compressed already), listed in the manifest (Part 2 §4).
		const entry = source.archive.get("META-INF/manifest.xml")

		if (entry === undefined) throw new OdtWriteRefusal("package", "the package has no manifest")

		const read = decodeUtf8(await source.archive.read(entry))
		const manifest = thumbnail ? withoutThumbnail(read) : read
		const prefix = /<([A-Za-z0-9_.-]+:)?manifest[\s>]/u.exec(manifest)?.[1] ?? ""
		let entries = ""

		const close = manifest.lastIndexOf("</")

		for (const [name, bytes] of pictures) {
			const extension = name.slice(name.lastIndexOf(".") + 1)
			const type = PICTURE_TYPES[extension] ?? "application/octet-stream"

			entries += `<${prefix}file-entry ${prefix}full-path="${esc(name)}" ${prefix}media-type="${type}"/>`
			add.push({ name, bytes, compress: false })
		}

		if (close < 0) throw new OdtWriteRefusal("package", "the manifest has no end")

		written = encodeUtf8(`${manifest.slice(0, close)}${entries}${manifest.slice(close)}`)

		assertWellFormed(parseXml(written))
		replace.push({ name: "META-INF/manifest.xml", bytes: written })
	}

	const sink = bufferSink(
		source.bytes.length +
			content.length / 4 +
			(styles?.length ?? 0) / 4 +
			(meta?.length ?? 0) / 4 +
			[...pictures.values()].reduce((sum, picture) => sum + picture.length, 0)
	)
	const deflate = nativeDeflate()
	const deflateChunks = nativeDeflateChunks()
	const slicing = job === undefined ? {} : { slicing: job.aborting }

	await writeZip(planZip(source.archive, { replace, add, remove }), source.archive, sink, {
		...(deflate === undefined ? { level: 6 } : { deflate }),
		...(deflateChunks === undefined ? {} : { deflateChunks }),
		...slicing
	})

	return { bytes: sink.bytes(), manifest: written }
}

// A manifest without the preview image's entry.
export function withoutThumbnail(manifest: string): string {
	const prefix = /<([A-Za-z0-9_.-]+:)?manifest[\s>]/u.exec(manifest)?.[1] ?? ""

	return manifest.replace(new RegExp(`<${prefix}file-entry\\s[^>]*full-path="Thumbnails/thumbnail\\.png"[^>]*/>\\s*`, "u"), "")
}

// The source file as an ODF package (what a translation of some of its blocks is given).
export async function sourcePackage(source: OdtSource): Promise<OdfPackage> {
	const opened = await OdfPackage.open(bytesSource(source.bytes), { kinds: ["text", "text-master", "text-web"] })

	if (!opened.ok) throw new OdtWriteRefusal("package", opened.message)

	return opened.package
}
