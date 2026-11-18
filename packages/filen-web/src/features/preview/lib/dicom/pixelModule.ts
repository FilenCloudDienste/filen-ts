import type { DataSet } from "dicom-parser"
import { DICOM_MAX_SIDE, type DicomDecoder, type TransferSyntax } from "@/features/preview/lib/dicom/transferSyntax"
import { nativeFrameBytes } from "@/features/preview/lib/dicom/frames.logic"
import {
	paletteChannel,
	paletteFirst,
	type Palette,
	type SampleColor,
	type VoiFunction,
	type Window
} from "@/features/preview/lib/dicom/pixels.logic"

// The Image Pixel module and its neighbours (PS3.3 C.7.6.3, C.11, C.7.6.6) as the viewer reads them from a parsed
// header, and whether the frames are something it can draw. Worker-only (it reads dicom-parser's data set).

export interface WindowPreset extends Window {
	// The file's Window Center & Width Explanation, when it gives one.
	readonly explanation: string | null
}

export interface PixelModule {
	readonly rows: number
	readonly columns: number
	readonly samplesPerPixel: number
	readonly photometric: string
	readonly planar: boolean
	readonly bitsAllocated: number
	readonly bitsStored: number
	readonly highBit: number
	readonly signed: boolean
	readonly frames: number
	readonly slope: number
	readonly intercept: number
	readonly windows: readonly WindowPreset[]
	readonly voiFunction: VoiFunction
	readonly palette: Palette | null
	readonly modality: string | null
	// Milliseconds between frames the file asks for, if any.
	readonly frameTimeMs: number | null
	// Row spacing over column spacing: how much taller than wide a pixel is shown.
	readonly pixelAspect: number
	// Pixel Data's value: its offset and length in the bytes it was read from (-1 for an undefined length).
	readonly pixelData: { readonly offset: number; readonly length: number } | null
	readonly extendedOffsets: readonly number[] | null
}

const GRAY = new Set(["MONOCHROME1", "MONOCHROME2"])

function int(dataSet: DataSet, tag: string): number | undefined {
	return dataSet.elements[tag] === undefined ? undefined : dataSet.uint16(tag)
}

function nonEmpty(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? ""

	return trimmed === "" ? null : trimmed
}

function strings(dataSet: DataSet, tag: string): string[] {
	const count = dataSet.numStringValues(tag) ?? 0
	const values: string[] = []

	for (let i = 0; i < Math.min(count, 16); i++) values.push(dataSet.string(tag, i) ?? "")

	return values
}

function decimals(dataSet: DataSet, tag: string): number[] {
	return strings(dataSet, tag)
		.map(value => Number.parseFloat(value))
		.filter(value => Number.isFinite(value))
}

function windows(dataSet: DataSet): WindowPreset[] {
	const centers = decimals(dataSet, "x00281050")
	const widths = decimals(dataSet, "x00281051")
	const explanations = strings(dataSet, "x00281055")

	return centers.flatMap((center, i) => {
		const width = widths[i]

		const explanation = explanations[i]?.trim() ?? ""

		return width === undefined || width < 1 ? [] : [{ center, width, explanation: explanation === "" ? null : explanation }]
	})
}

function voiFunction(dataSet: DataSet): VoiFunction {
	const declared = dataSet.string("x00281056")?.trim()

	return declared === "LINEAR_EXACT" || declared === "SIGMOID" ? declared : "LINEAR"
}

function palette(dataSet: DataSet, signed: boolean, littleEndian: boolean): Palette | null {
	const channels: Uint8Array[] = []
	let entries = 0
	let first = 0

	for (const [descriptorTag, dataTag] of [
		["x00281101", "x00281201"],
		["x00281102", "x00281202"],
		["x00281103", "x00281203"]
	] as const) {
		const element = dataSet.elements[dataTag]
		const descriptor = [0, 1, 2].map(i => dataSet.uint16(descriptorTag, i) ?? -1)

		if (element === undefined || descriptor.some(value => value < 0)) return null
		if (element.dataOffset + element.length > dataSet.byteArray.length) return null

		const channel = paletteChannel(
			descriptor,
			dataSet.byteArray.subarray(element.dataOffset, element.dataOffset + element.length),
			littleEndian
		)

		if (channel === null) return null

		entries = channel.length
		first = paletteFirst(descriptor[1] ?? 0, signed)
		channels.push(channel)
	}

	const [red, green, blue] = channels

	if (red === undefined || green === undefined || blue === undefined || green.length !== entries || blue.length !== entries) return null

	return { entries, first, red, green, blue }
}

function frameTime(dataSet: DataSet): number | null {
	const ms = dataSet.floatString("x00181063")

	if (ms !== undefined && Number.isFinite(ms) && ms > 0) return ms

	for (const tag of ["x00180040", "x00082144"]) {
		const rate = dataSet.intString(tag)

		if (rate !== undefined && Number.isFinite(rate) && rate > 0) return 1000 / rate
	}

	return null
}

function pixelAspect(dataSet: DataSet): number {
	const spacing = decimals(dataSet, "x00280030")
	const [row, column] = spacing

	if (row !== undefined && column !== undefined && row > 0 && column > 0) return row / column

	const ratio = strings(dataSet, "x00280034").map(value => Number.parseInt(value, 10))
	const [vertical, horizontal] = ratio

	return vertical !== undefined && horizontal !== undefined && vertical > 0 && horizontal > 0 ? vertical / horizontal : 1
}

function extendedOffsets(dataSet: DataSet, littleEndian: boolean): number[] | null {
	const element = dataSet.elements["x7fe00001"]

	if (element === undefined || element.length % 8 !== 0 || element.dataOffset + element.length > dataSet.byteArray.length) return null

	const view = new DataView(dataSet.byteArray.buffer, dataSet.byteArray.byteOffset + element.dataOffset, element.length)
	const offsets: number[] = []

	for (let at = 0; at < element.length; at += 8) {
		const offset = view.getBigUint64(at, littleEndian)

		if (offset > BigInt(Number.MAX_SAFE_INTEGER)) return null

		offsets.push(Number(offset))
	}

	return offsets
}

export function readPixelModule(dataSet: DataSet, littleEndian: boolean): PixelModule {
	const samplesPerPixel = int(dataSet, "x00280002") ?? 1
	const bitsAllocated = int(dataSet, "x00280100") ?? 0
	const bitsStored = int(dataSet, "x00280101") ?? bitsAllocated
	const signed = int(dataSet, "x00280103") === 1
	const pixel = dataSet.elements["x7fe00010"]
	const frames = dataSet.intString("x00280008")

	return {
		rows: int(dataSet, "x00280010") ?? 0,
		columns: int(dataSet, "x00280011") ?? 0,
		samplesPerPixel,
		photometric: (dataSet.string("x00280004") ?? (samplesPerPixel === 3 ? "RGB" : "MONOCHROME2")).trim().toUpperCase(),
		planar: int(dataSet, "x00280006") === 1,
		bitsAllocated,
		bitsStored,
		highBit: int(dataSet, "x00280102") ?? bitsStored - 1,
		signed,
		frames: frames !== undefined && Number.isSafeInteger(frames) && frames > 0 ? frames : 1,
		slope: dataSet.floatString("x00281053") ?? 1,
		intercept: dataSet.floatString("x00281052") ?? 0,
		windows: windows(dataSet),
		voiFunction: voiFunction(dataSet),
		palette: palette(dataSet, signed, littleEndian),
		modality: nonEmpty(dataSet.string("x00080060")),
		frameTimeMs: frameTime(dataSet),
		pixelAspect: pixelAspect(dataSet),
		pixelData: pixel === undefined ? null : { offset: pixel.dataOffset, length: pixel.hadUndefinedLength === true ? -1 : pixel.length },
		extendedOffsets: extendedOffsets(dataSet, littleEndian)
	}
}

export type ImageVerdict =
	{ readonly status: "ok"; readonly color: SampleColor } | { readonly status: "noImage" | "unsupported" | "damaged" | "tooLarge" }

// The colour model the frames decode to, by decoder (a JPEG decoded by the browser is RGB whatever the tag says; a
// JPEG 2000 decoder has applied its own colour transform), or null for a pairing the viewer does not draw.
function sampleColor(module: PixelModule, decoder: DicomDecoder): SampleColor | null {
	const { photometric, samplesPerPixel } = module

	if (GRAY.has(photometric)) return samplesPerPixel === 1 ? "gray" : null
	if (photometric === "PALETTE COLOR") return samplesPerPixel === 1 && module.palette !== null ? "palette" : null
	if (samplesPerPixel !== 3) return null

	switch (decoder) {
		case "jpegBaseline":
			return photometric === "RGB" || photometric.startsWith("YBR_") ? "rgb" : null
		case "jpeg2000":
		case "htj2k":
			return photometric === "YBR_ICT" || photometric === "YBR_RCT" || photometric === "RGB"
				? "rgb"
				: photometric === "YBR_FULL"
					? "ybrFull"
					: null
		case "native":
			return photometric === "RGB"
				? "rgb"
				: photometric === "YBR_FULL"
					? "ybrFull"
					: photometric === "YBR_FULL_422"
						? "ybrFull422"
						: null
		case "rle":
		case "jpegLossless":
		case "jpegLs":
			return photometric === "RGB" ? "rgb" : photometric === "YBR_FULL" || photometric === "YBR_FULL_422" ? "ybrFull" : null
	}
}

// Whether the frames can be drawn, from the tags alone. `decoders` are the ones this build carries.
export function imageVerdict(module: PixelModule, syntax: TransferSyntax | null, decoders: ReadonlySet<DicomDecoder>): ImageVerdict {
	const { rows, columns, bitsAllocated, bitsStored, highBit } = module

	if (module.pixelData === null) return { status: "noImage" }
	if (syntax === null || !decoders.has(syntax.decoder)) return { status: "unsupported" }
	if (rows < 1 || columns < 1 || bitsStored < 1 || bitsStored > bitsAllocated || highBit < bitsStored - 1 || highBit >= bitsAllocated) {
		return { status: "damaged" }
	}
	if (rows > DICOM_MAX_SIDE || columns > DICOM_MAX_SIDE) return { status: "tooLarge" }

	const color = sampleColor(module, syntax.decoder)

	if (color === null) return { status: "unsupported" }

	if (!syntax.encapsulated) {
		const frameBytes = nativeFrameBytes({
			rows,
			columns,
			samplesPerPixel: module.samplesPerPixel,
			bitsAllocated,
			subsampled: color === "ybrFull422"
		})

		if (frameBytes === null) return { status: "unsupported" }
		// An undefined length on native pixel data is no layout the standard has.
		if (module.pixelData.length < 0) return { status: "damaged" }
	} else if (module.pixelData.length >= 0 || bitsAllocated > 16) {
		return module.pixelData.length >= 0 ? { status: "damaged" } : { status: "unsupported" }
	}

	return { status: "ok", color }
}
