import { COLOR_ELEMENTS, readColor, readColorIn } from "./color"
import { type DrawingImage, type ImageFormat, type ImageHandling, type Inset, type Rgba } from "./displayList"
import type { PaintContext } from "./fill"
import { D, type DrawingReader } from "./reader"

// An image relationship resolved by the host: the internal part and its content type. Undefined for
// external targets (never fetched) and missing parts.
export interface ImageTarget {
	readonly partName: string
	readonly contentType: string | undefined
}

export type ImageResolver = (relationshipId: string) => ImageTarget | undefined

const SVG_BLIP_EXTENSION = "{96DAC541-7B7A-43D3-8B79-37D633B846F1}"

const FORMAT_BY_TYPE: Readonly<Record<string, ImageFormat>> = {
	"image/png": "png",
	"image/jpeg": "jpeg",
	"image/jpg": "jpeg",
	"image/pjpeg": "jpeg",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/x-bmp": "bmp",
	"image/x-ms-bmp": "bmp",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/tiff": "tiff",
	"image/x-emf": "emf",
	"image/emf": "emf",
	"application/x-emf": "emf",
	"image/x-wmf": "wmf",
	"image/wmf": "wmf",
	"application/x-msmetafile": "wmf"
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, ImageFormat>> = {
	png: "png",
	jpg: "jpeg",
	jpeg: "jpeg",
	jpe: "jpeg",
	jfif: "jpeg",
	gif: "gif",
	bmp: "bmp",
	dib: "bmp",
	webp: "webp",
	svg: "svg",
	tif: "tiff",
	tiff: "tiff",
	emf: "emf",
	emz: "emf",
	wmf: "wmf",
	wmz: "wmf"
}

export function imageFormat(partName: string, contentType: string | undefined): ImageFormat {
	const byType = contentType === undefined ? undefined : FORMAT_BY_TYPE[contentType.toLowerCase().split(";")[0]?.trim() ?? ""]

	if (byType !== undefined) return byType

	const dot = partName.lastIndexOf(".")

	return dot < 0 ? "unknown" : (FORMAT_BY_EXTENSION[partName.slice(dot + 1).toLowerCase()] ?? "unknown")
}

export function imageHandling(format: ImageFormat): ImageHandling {
	switch (format) {
		case "png":
		case "jpeg":
		case "gif":
		case "bmp":
		case "webp":
			return "native"
		case "svg":
			return "sanitize"
		case "tiff":
			return "convert"
		case "emf":
		case "wmf":
			return "metafile"
		default:
			return "placeholder"
	}
}

const NO_CROP: Inset = { left: 0, top: 0, right: 0, bottom: 0 }

// A placeholder image for an external, missing or unreadable picture.
export const MISSING_IMAGE: DrawingImage = {
	partName: undefined,
	format: "unknown",
	handling: "placeholder",
	svgPartName: undefined,
	crop: NO_CROP,
	alpha: 1,
	grayscale: false,
	biLevel: -1,
	duotone: null,
	brightness: 0,
	contrast: 0,
	colorChange: null
}

// Reads the a:blip of a blip fill (pic:blipFill, a:blipFill, dsp/c blip fills) with its crop and the
// supported effects into the list's image table; the image index, or -1 without a blip. `placeholder` is the colour a
// style reference gives phClr (a theme fill style's duotone and colour change are written in it).
export function readBlip(context: PaintContext, reader: DrawingReader, blipFill: number, placeholder?: Rgba): number {
	const blip = reader.child(blipFill, D.A, "blip")

	if (blip < 0) return -1

	// A blip inside the theme part (a fill style reached through a:fillRef) names the theme's relationships.
	const formats = context.theme.formats
	const images = formats !== undefined && reader === formats.reader ? formats.images : context.images
	const embed = reader.attrNs(blip, D.R, "embed")
	const target = embed === undefined ? undefined : images(embed)
	let svgPartName: string | undefined

	for (const ext of reader.children(reader.child(blip, D.A, "extLst"), D.A, "ext")) {
		if (reader.attr(ext, "uri") !== SVG_BLIP_EXTENSION) continue

		const svg = reader.child(ext, D.Asvg, "svgBlip")
		const id = svg < 0 ? undefined : reader.attrNs(svg, D.R, "embed")
		const svgTarget = id === undefined ? undefined : images(id)

		if (svgTarget !== undefined && imageFormat(svgTarget.partName, svgTarget.contentType) === "svg") svgPartName = svgTarget.partName
	}

	const srcRect = reader.child(blipFill, D.A, "srcRect")
	const crop: Inset =
		srcRect < 0
			? NO_CROP
			: {
					left: reader.fraction(srcRect, "l", 0),
					top: reader.fraction(srcRect, "t", 0),
					right: reader.fraction(srcRect, "r", 0),
					bottom: reader.fraction(srcRect, "b", 0)
				}
	let alpha = 1
	let grayscale = false
	let biLevel = -1
	let duotone: readonly [Rgba, Rgba] | null = null
	let brightness = 0
	let contrast = 0
	let colorChange: readonly [Rgba, Rgba] | null = null
	const document = reader.document

	for (let effect = document.firstChildElement(blip); effect >= 0; effect = document.nextSiblingElement(effect)) {
		if (reader.group(effect) !== D.A) continue

		switch (document.localName(effect)) {
			case "alphaModFix":
				alpha *= reader.fraction(effect, "amt", 1)
				break
			case "grayscl":
				grayscale = true
				break
			case "biLevel":
				biLevel = reader.fraction(effect, "thresh", 0.5)
				break
			case "duotone": {
				const colors: Rgba[] = []

				for (let child = document.firstChildElement(effect); child >= 0; child = document.nextSiblingElement(child)) {
					const color =
						reader.group(child) === D.A && COLOR_ELEMENTS.has(document.localName(child))
							? readColor(reader, child, context.theme, placeholder)
							: undefined

					if (color !== undefined) colors.push(color)
				}

				if (colors.length >= 2) duotone = [colors[0] ?? 0, colors[1] ?? 0]

				break
			}
			case "lum":
				brightness = reader.fraction(effect, "bright", 0)
				contrast = reader.fraction(effect, "contrast", 0)
				break
			case "clrChange": {
				const from = readColorIn(reader, reader.child(effect, D.A, "clrFrom"), context.theme, placeholder)
				const to = readColorIn(reader, reader.child(effect, D.A, "clrTo"), context.theme, placeholder)

				if (from !== undefined && to !== undefined) colorChange = [from, to]

				break
			}
			default:
				break
		}
	}

	if (target === undefined && svgPartName === undefined) return context.list.image({ ...MISSING_IMAGE, crop })

	const format = target === undefined ? "svg" : imageFormat(target.partName, target.contentType)

	return context.list.image({
		partName: target?.partName ?? svgPartName,
		format,
		handling: imageHandling(format),
		svgPartName,
		crop,
		alpha,
		grayscale,
		biLevel,
		duotone,
		brightness,
		contrast,
		colorChange
	})
}
