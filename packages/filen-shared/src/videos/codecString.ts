// RFC 6381 `codecs` values built from the raw codec configuration records a container carries (MP4 sample
// entry children, Matroska CodecPrivate). A record that cannot be read gives null; nothing here throws.

function hex(value: number, digits: number): string {
	return value.toString(16).padStart(digits, "0")
}

function dec(value: number, digits: number): string {
	return String(value).padStart(digits, "0")
}

// MSB-first bit reader over a byte array; null once a read would run past the end.
// Reads big-endian bit fields and Exp-Golomb codes; reads past the end give null.
export class BitReader {
	private position = 0
	private readonly bytes: Uint8Array

	public constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}

	public get left(): number {
		return this.bytes.length * 8 - this.position
	}

	public read(count: number): number | null {
		if (count > this.left) {
			return null
		}

		let value = 0

		for (let i = 0; i < count; i++) {
			const byte = this.bytes[this.position >> 3] ?? 0

			value = value * 2 + ((byte >> (7 - (this.position & 7))) & 1)
			this.position++
		}

		return value
	}

	public skip(count: number): boolean {
		if (count > this.left) {
			return false
		}

		this.position += count

		return true
	}

	// Unsigned Exp-Golomb (ue(v)); null past the end or beyond 32 bits.
	public ue(): number | null {
		let zeros = 0
		let bit = this.read(1)

		while (bit === 0) {
			zeros++

			if (zeros > 31) {
				return null
			}

			bit = this.read(1)
		}

		const rest = bit === null ? null : this.read(zeros)

		return rest === null ? null : 2 ** zeros - 1 + rest
	}

	// Signed Exp-Golomb (se(v)).
	public se(): number | null {
		const value = this.ue()

		return value === null ? null : value % 2 === 1 ? (value + 1) / 2 : -(value / 2)
	}
}

// ── Video ────────────────────────────────────────────────────────────────────

export interface AvcConfig {
	profile: number
	compatibility: number
	level: number
	bitDepth: number
}

// High-family profiles whose avcC may carry the chroma/bit-depth extension after the parameter sets.
const AVC_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

// AVCDecoderConfigurationRecord (the avcC box payload, or a Matroska V_MPEG4/ISO/AVC CodecPrivate).
export function parseAvcC(avcC: Uint8Array): AvcConfig | null {
	const version = avcC[0]
	const profile = avcC[1]
	const compatibility = avcC[2]
	const level = avcC[3]

	if (version !== 1 || profile === undefined || compatibility === undefined || level === undefined) {
		return null
	}

	// High 10 and up imply more than 8 bits even when the extension is absent.
	let bitDepth = profile === 110 || profile === 122 || profile === 244 ? 10 : 8

	if (AVC_HIGH_PROFILES.has(profile)) {
		let at = 5
		const spsCount = (avcC[at] ?? 0) & 0x1f

		at++

		for (let i = 0; i < spsCount && at + 2 <= avcC.length; i++) {
			at += 2 + ((avcC[at] ?? 0) << 8) + (avcC[at + 1] ?? 0)
		}

		const ppsCount = avcC[at] ?? 0

		at++

		for (let i = 0; i < ppsCount && at + 2 <= avcC.length; i++) {
			at += 2 + ((avcC[at] ?? 0) << 8) + (avcC[at + 1] ?? 0)
		}

		// chroma_format(2), bit_depth_luma_minus8(3), bit_depth_chroma_minus8(3), each after reserved bits.
		const luma = avcC[at + 1]

		if (at + 4 <= avcC.length && luma !== undefined) {
			bitDepth = (luma & 0x07) + 8
		}
	}

	return { profile, compatibility, level, bitDepth }
}

// `fourcc` is the sample entry type (avc1, avc3); anything else is written as avc1.
export function avcConfigCodecString(fourcc: string, config: Pick<AvcConfig, "profile" | "compatibility" | "level">): string {
	return `${fourcc === "avc3" ? "avc3" : "avc1"}.${hex(config.profile, 2)}${hex(config.compatibility, 2)}${hex(config.level, 2)}`
}

export function avcCodecString({ fourcc, avcC }: { fourcc: string; avcC: Uint8Array }): string | null {
	const config = parseAvcC(avcC)

	return config === null ? null : avcConfigCodecString(fourcc, config)
}

export interface HevcConfig {
	profileSpace: number
	tier: number
	profile: number
	compatibility: number
	constraints: number[]
	level: number
	bitDepth: number
}

// HEVCDecoderConfigurationRecord (the hvcC box payload, or a Matroska V_MPEGH/ISO/HEVC CodecPrivate).
export function parseHvcC(hvcC: Uint8Array): HevcConfig | null {
	if (hvcC.length < 23 || hvcC[0] !== 1) {
		return null
	}

	const first = hvcC[1] ?? 0
	const constraints: number[] = []

	for (let i = 6; i < 12; i++) {
		constraints.push(hvcC[i] ?? 0)
	}

	return {
		profileSpace: first >> 6,
		tier: (first >> 5) & 1,
		profile: first & 0x1f,
		compatibility: (hvcC[2] ?? 0) * 0x1000000 + ((hvcC[3] ?? 0) << 16) + ((hvcC[4] ?? 0) << 8) + (hvcC[5] ?? 0),
		constraints,
		level: hvcC[12] ?? 0,
		bitDepth: ((hvcC[17] ?? 0) & 0x07) + 8
	}
}

function reverseBits32(value: number): number {
	let reversed = 0

	for (let i = 0; i < 32; i++) {
		reversed = reversed * 2 + (Math.floor(value / 2 ** i) % 2)
	}

	return reversed
}

// `fourcc` is the sample entry type (hvc1, hev1); anything else is written as hvc1, which is what a remux writes.
export function hevcCodecString({ fourcc, hvcC }: { fourcc: string; hvcC: Uint8Array }): string | null {
	const config = parseHvcC(hvcC)

	return config === null ? null : hevcConfigCodecString(fourcc, config)
}

export function hevcConfigCodecString(fourcc: string, config: Omit<HevcConfig, "bitDepth">): string {
	const space = ["", "A", "B", "C"][config.profileSpace] ?? ""
	const constraints = [...config.constraints]

	while (constraints.length > 0 && constraints[constraints.length - 1] === 0) {
		constraints.pop()
	}

	const parts = [
		fourcc === "hev1" ? "hev1" : "hvc1",
		`${space}${String(config.profile)}`,
		reverseBits32(config.compatibility).toString(16).toUpperCase(),
		`${config.tier === 1 ? "H" : "L"}${String(config.level)}`,
		...constraints.map(byte => byte.toString(16).toUpperCase())
	]

	return parts.join(".")
}

// ISO/IEC 23091-2 colour description; `fullRange` false is limited range.
export interface ColourInfo {
	primaries: number
	transfer: number
	matrix: number
	fullRange: boolean
}

// 2 means "unspecified", which says nothing beyond the BT.709 default.
function knownColour(colour: ColourInfo | null | undefined): ColourInfo | null {
	if (colour === null || colour === undefined) {
		return null
	}

	return {
		primaries: colour.primaries === 2 ? 1 : colour.primaries,
		transfer: colour.transfer === 2 ? 1 : colour.transfer,
		matrix: colour.matrix === 2 ? 1 : colour.matrix,
		fullRange: colour.fullRange
	}
}

function isDefaultColour(colour: ColourInfo): boolean {
	return colour.primaries === 1 && colour.transfer === 1 && colour.matrix === 1 && !colour.fullRange
}

export interface Av1Config {
	profile: number
	level: number
	tier: number
	bitDepth: number
	monochrome: boolean
	subsamplingX: number
	subsamplingY: number
	chromaSamplePosition: number
}

// AV1CodecConfigurationRecord (the av1C box payload, or a Matroska V_AV1 CodecPrivate).
export function parseAv1C(av1C: Uint8Array): Av1Config | null {
	const marker = av1C[0]
	const first = av1C[1]
	const second = av1C[2]

	if (marker !== 0x81 || first === undefined || second === undefined) {
		return null
	}

	const profile = first >> 5
	const highBitDepth = (second >> 6) & 1
	const twelveBit = (second >> 5) & 1

	return {
		profile,
		level: first & 0x1f,
		tier: second >> 7,
		bitDepth: profile === 2 && highBitDepth === 1 ? (twelveBit === 1 ? 12 : 10) : highBitDepth === 1 ? 10 : 8,
		monochrome: ((second >> 4) & 1) === 1,
		subsamplingX: (second >> 3) & 1,
		subsamplingY: (second >> 2) & 1,
		chromaSamplePosition: second & 0x03
	}
}

// av01.P.LLT.DD, with the optional .M.CCC.cp.tc.mc.F tail only when the colour is known and not the default.
export function av1CodecString({ av1C, colour }: { av1C: Uint8Array; colour?: ColourInfo | null }): string | null {
	const config = parseAv1C(av1C)

	if (config === null) {
		return null
	}

	const base = `av01.${String(config.profile)}.${dec(config.level, 2)}${config.tier === 1 ? "H" : "M"}.${dec(config.bitDepth, 2)}`
	const known = knownColour(colour)
	const chroma = `${String(config.subsamplingX)}${String(config.subsamplingY)}${String(config.chromaSamplePosition)}`
	const defaultChroma = !config.monochrome && config.subsamplingX === 1 && config.subsamplingY === 1

	if ((known === null || isDefaultColour(known)) && defaultChroma) {
		return base
	}

	const tail = known ?? { primaries: 1, transfer: 1, matrix: 1, fullRange: false }

	return [
		base,
		config.monochrome ? "1" : "0",
		chroma,
		dec(tail.primaries, 2),
		dec(tail.transfer, 2),
		dec(tail.matrix, 2),
		tail.fullRange ? "1" : "0"
	].join(".")
}

export interface Vp9Config {
	profile: number
	level: number
	bitDepth: number
	// 0/1 4:2:0 (vertical, colocated), 2 4:2:2, 3 4:4:4.
	chromaSubsampling: number
	colour: ColourInfo | null
}

// VPCodecConfigurationRecord: the vpcC box payload, version/flags included.
export function parseVpcC(vpcC: Uint8Array): Vp9Config | null {
	const version = vpcC[0]
	const profile = vpcC[4]
	const level = vpcC[5]
	const packed = vpcC[6]

	if (version === undefined || profile === undefined || level === undefined || packed === undefined) {
		return null
	}

	if (version === 0) {
		// The pre-standard layout: bitDepth(4) colorSpace(4), then chromaSubsampling(4) and the rest.
		return { profile, level, bitDepth: packed >> 4, chromaSubsampling: (vpcC[7] ?? 0x10) >> 4, colour: null }
	}

	const primaries = vpcC[7]
	const transfer = vpcC[8]
	const matrix = vpcC[9]

	return {
		profile,
		level,
		bitDepth: packed >> 4,
		chromaSubsampling: (packed >> 1) & 0x07,
		colour:
			primaries === undefined || transfer === undefined || matrix === undefined
				? null
				: { primaries, transfer, matrix, fullRange: (packed & 1) === 1 }
	}
}

// Matroska V_VP9 CodecPrivate: optional {id, length, value} features. Absent features stay undefined.
export function parseMatroskaVp9Private(bytes: Uint8Array): {
	profile?: number
	level?: number
	bitDepth?: number
	chromaSubsampling?: number
} {
	const features: { profile?: number; level?: number; bitDepth?: number; chromaSubsampling?: number } = {}
	let at = 0

	while (at + 2 <= bytes.length) {
		const id = bytes[at] ?? 0
		const length = bytes[at + 1] ?? 0
		const value = bytes[at + 2]

		if (length !== 1 || value === undefined) {
			break
		}

		if (id === 1) {
			features.profile = value
		} else if (id === 2) {
			features.level = value
		} else if (id === 3) {
			features.bitDepth = value
		} else if (id === 4) {
			features.chromaSubsampling = value
		}

		at += 2 + length
	}

	return features
}

// VP9 levels by the largest luma picture each allows, for a stream whose container does not say.
const VP9_LEVELS: readonly (readonly [number, number])[] = [
	[10, 36_864],
	[11, 73_728],
	[20, 122_880],
	[21, 245_760],
	[30, 552_960],
	[31, 983_040],
	[40, 2_228_224],
	[50, 8_912_896],
	[60, 35_651_584]
]

export function vp9LevelForSize({ width, height }: { width: number; height: number }): number {
	const area = width * height

	for (const [level, maxArea] of VP9_LEVELS) {
		if (area <= maxArea) {
			return level
		}
	}

	return 62
}

// vp09.PP.LL.DD, with the .CC.cp.tc.mc.FF tail only when the colour is known and not the default.
export function vp9CodecString(config: Vp9Config): string | null {
	const { profile, level, bitDepth, chromaSubsampling } = config

	if (profile > 3 || level === 0 || (bitDepth !== 8 && bitDepth !== 10 && bitDepth !== 12) || chromaSubsampling > 3) {
		return null
	}

	const base = `vp09.${dec(profile, 2)}.${dec(level, 2)}.${dec(bitDepth, 2)}`
	const known = knownColour(config.colour)

	if ((known === null || isDefaultColour(known)) && chromaSubsampling <= 1) {
		return base
	}

	const tail = known ?? { primaries: 1, transfer: 1, matrix: 1, fullRange: false }

	return [
		base,
		dec(chromaSubsampling, 2),
		dec(tail.primaries, 2),
		dec(tail.transfer, 2),
		dec(tail.matrix, 2),
		tail.fullRange ? "01" : "00"
	].join(".")
}

// ── Parameter sets ───────────────────────────────────────────────────────────

// What an AVC/HEVC sequence parameter set says about the picture, for streams that carry no
// configuration record (MPEG-TS, Annex B elementary streams).
export interface SpsPicture {
	width: number
	height: number
	bitDepth: number
	// Sample aspect ratio, width over height.
	par: number
	// ISO/IEC 23091-2 TransferCharacteristics, null when the VUI does not say.
	transfer: number | null
}

// What decoding a slice header's picture order count takes from the SPS (H.264 7.4.2.1.1).
export interface AvcPocParams {
	log2MaxFrameNum: number
	pocType: 0 | 1 | 2
	// pic_order_cnt_type 0.
	log2MaxPocLsb: number
	// pic_order_cnt_type 1.
	deltaPicOrderAlwaysZero: boolean
	offsetForNonRefPic: number
	offsetForTopToBottomField: number
	offsetsForRefFrame: number[]
	frameMbsOnly: boolean
	separateColourPlane: boolean
}

export type AvcSps = SpsPicture &
	Pick<AvcConfig, "profile" | "compatibility" | "level"> & {
		poc: AvcPocParams
		// A frame's duration from the VUI's timing info; null when it does not say.
		frameSeconds: number | null
	}

export type HevcSps = SpsPicture & Omit<HevcConfig, "bitDepth">

// A NAL unit's payload with the emulation-prevention bytes (00 00 03 → 00 00) removed.
export function unescapeRbsp(nal: Uint8Array): Uint8Array {
	const out = new Uint8Array(nal.length)
	let length = 0
	let zeros = 0

	for (const byte of nal) {
		if (zeros >= 2 && byte === 3) {
			zeros = 0

			continue
		}

		out[length++] = byte
		zeros = byte === 0 ? zeros + 1 : 0
	}

	return out.subarray(0, length)
}

// Table E-1 sample aspect ratios by aspect_ratio_idc.
const SAMPLE_ASPECT_RATIOS: readonly (readonly [number, number])[] = [
	[0, 0],
	[1, 1],
	[12, 11],
	[10, 11],
	[16, 11],
	[40, 33],
	[24, 11],
	[20, 11],
	[32, 11],
	[80, 33],
	[18, 11],
	[15, 11],
	[64, 33],
	[160, 99],
	[4, 3],
	[3, 2],
	[2, 1]
]

// The start both VUI syntaxes share: aspect ratio, overscan, then the video signal type's colour description.
interface Vui {
	par: number
	transfer: number | null
	// AVC only: a frame's duration from timing_info (two ticks a frame); null when the VUI does not say.
	frameSeconds: number | null
}

// The VUI fields read: the sample aspect ratio, the transfer characteristics and, for AVC (`avc`), whose timing info
// follows the chroma location directly, the frame duration.
function readVui(bits: BitReader, avc: boolean): Vui {
	let par = 1

	if (bits.read(1) === 1) {
		const idc = bits.read(8)
		let ratio = idc === null ? undefined : SAMPLE_ASPECT_RATIOS[idc]

		if (idc === 255) {
			const width = bits.read(16)
			const height = bits.read(16)

			ratio = width === null || height === null ? undefined : [width, height]
		}

		if (ratio !== undefined && ratio[0] > 0 && ratio[1] > 0) {
			par = Math.round((ratio[0] / ratio[1]) * 10_000) / 10_000
		}
	}

	if (bits.read(1) === 1) {
		bits.read(1)
	}

	let transfer: number | null = null

	// video_signal_type: format and range, then colour description.
	if (bits.read(1) === 1) {
		bits.read(4)

		if (bits.read(1) === 1) {
			bits.read(8)
			transfer = bits.read(8)
			bits.read(8)
		}
	}

	if (!avc) {
		return { par, transfer, frameSeconds: null }
	}

	if (bits.read(1) === 1) {
		bits.ue()
		bits.ue()
	}

	let frameSeconds: number | null = null

	if (bits.read(1) === 1) {
		const units = bits.read(32)
		const scale = bits.read(32)

		frameSeconds = units !== null && scale !== null && units > 0 && scale > 0 ? (2 * units) / scale : null
	}

	return { par, transfer, frameSeconds }
}

// Cropped picture size; null for one no decoder would produce.
function croppedSize(width: number, height: number, crop: readonly number[], unitX: number, unitY: number): [number, number] | null {
	const w = width - unitX * ((crop[0] ?? 0) + (crop[1] ?? 0))
	const h = height - unitY * ((crop[2] ?? 0) + (crop[3] ?? 0))

	return w > 0 && h > 0 && w <= 65_536 && h <= 65_536 ? [w, h] : null
}

function readCrop(bits: BitReader): number[] | null {
	const crop: number[] = []

	for (let i = 0; i < 4; i++) {
		const value = bits.ue()

		if (value === null) {
			return null
		}

		crop.push(value)
	}

	return crop
}

function skipAvcScalingList(bits: BitReader, size: number): boolean {
	let last = 8
	let next = 8

	for (let i = 0; i < size; i++) {
		if (next !== 0) {
			const delta = bits.se()

			if (delta === null) {
				return false
			}

			next = (last + delta + 256) % 256
		}

		last = next === 0 ? last : next
	}

	return true
}

// seq_parameter_set_rbsp() of an AVC SPS NAL unit (header byte included, emulation prevention not removed).
export function parseAvcSps(nal: Uint8Array): AvcSps | null {
	if (((nal[0] ?? 0) & 0x1f) !== 7 || nal.length < 5) {
		return null
	}

	const bits = new BitReader(unescapeRbsp(nal.subarray(1)))
	const profile = bits.read(8)
	const compatibility = bits.read(8)
	const level = bits.read(8)

	if (profile === null || compatibility === null || level === null || bits.ue() === null) {
		return null
	}

	// ChromaArrayType: chroma_format_idc, or 0 for 4:4:4 coded as three separate colour planes.
	let chroma = 1
	let bitDepth = 8
	let separateColourPlane = false

	if (AVC_HIGH_PROFILES.has(profile)) {
		const chromaFormat = bits.ue() ?? -1

		if (chromaFormat < 0 || chromaFormat > 3) {
			return null
		}

		separateColourPlane = chromaFormat === 3 && bits.read(1) === 1
		chroma = separateColourPlane ? 0 : chromaFormat

		const luma = bits.ue()

		if (luma === null || luma > 6 || bits.ue() === null) {
			return null
		}

		bitDepth = luma + 8
		bits.read(1)

		// Twelve scaling lists for 4:4:4 (separate colour planes included), eight otherwise.
		if (bits.read(1) === 1) {
			for (let i = 0; i < (chromaFormat === 3 ? 12 : 8); i++) {
				if (bits.read(1) === 1 && !skipAvcScalingList(bits, i < 6 ? 16 : 64)) {
					return null
				}
			}
		}
	}

	const log2MaxFrameNum = (bits.ue() ?? -1) + 4
	const pocType = bits.ue()
	let log2MaxPocLsb = 4
	let deltaPicOrderAlwaysZero = false
	let offsetForNonRefPic = 0
	let offsetForTopToBottomField = 0
	const offsetsForRefFrame: number[] = []

	if (log2MaxFrameNum < 4 || log2MaxFrameNum > 16) {
		return null
	}

	if (pocType === 0) {
		log2MaxPocLsb = (bits.ue() ?? -1) + 4

		if (log2MaxPocLsb < 4 || log2MaxPocLsb > 16) {
			return null
		}
	} else if (pocType === 1) {
		deltaPicOrderAlwaysZero = bits.read(1) === 1
		offsetForNonRefPic = bits.se() ?? 0
		offsetForTopToBottomField = bits.se() ?? 0

		const cycle = bits.ue()

		if (cycle === null || cycle > 255) {
			return null
		}

		for (let i = 0; i < cycle; i++) {
			offsetsForRefFrame.push(bits.se() ?? 0)
		}
	} else if (pocType !== 2) {
		return null
	}

	bits.ue()
	bits.read(1)

	const widthMbs = bits.ue()
	const heightUnits = bits.ue()
	const frameMbsOnly = bits.read(1)

	if (widthMbs === null || heightUnits === null || frameMbsOnly === null) {
		return null
	}

	if (frameMbsOnly === 0) {
		bits.read(1)
	}

	bits.read(1)

	const crop = bits.read(1) === 1 ? readCrop(bits) : [0, 0, 0, 0]

	if (crop === null) {
		return null
	}

	const fieldFactor = 2 - frameMbsOnly
	const size = croppedSize(
		(widthMbs + 1) * 16,
		(heightUnits + 1) * 16 * fieldFactor,
		crop,
		chroma === 0 || chroma === 3 ? 1 : 2,
		(chroma === 1 ? 2 : 1) * fieldFactor
	)

	if (size === null) {
		return null
	}

	const vui = bits.read(1) === 1 ? readVui(bits, true) : { par: 1, transfer: null, frameSeconds: null }

	return {
		profile,
		compatibility,
		level,
		width: size[0],
		height: size[1],
		bitDepth,
		...vui,
		poc: {
			log2MaxFrameNum,
			pocType,
			log2MaxPocLsb,
			deltaPicOrderAlwaysZero,
			offsetForNonRefPic,
			offsetForTopToBottomField,
			offsetsForRefFrame,
			frameMbsOnly: frameMbsOnly === 1,
			separateColourPlane
		}
	}
}

function skipHevcScalingListData(bits: BitReader): boolean {
	for (let sizeId = 0; sizeId < 4; sizeId++) {
		for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
			if (bits.read(1) === 0) {
				if (bits.ue() === null) {
					return false
				}

				continue
			}

			const coefficients = Math.min(64, 1 << (4 + (sizeId << 1)))

			if (sizeId > 1 && bits.se() === null) {
				return false
			}

			for (let i = 0; i < coefficients; i++) {
				if (bits.se() === null) {
					return false
				}
			}
		}
	}

	return true
}

// st_ref_pic_set() of an SPS. A set predicted from the one before it signals a flag per delta POC of
// that set, so each set's negative (S0) and positive (S1) deltas are derived as in H.265 (7-61, 7-62).
function skipShortTermRefPicSets(bits: BitReader, count: number): boolean {
	let previous: { s0: number[]; s1: number[] } = { s0: [], s1: [] }

	for (let index = 0; index < count; index++) {
		if (index !== 0 && bits.read(1) === 1) {
			const sign = bits.read(1)
			const magnitude = bits.ue()

			if (sign === null || magnitude === null) {
				return false
			}

			const deltaRps = (1 - 2 * sign) * (magnitude + 1)
			const deltas = previous.s0.length + previous.s1.length
			const use: number[] = []

			for (let j = 0; j <= deltas; j++) {
				const usedByCurrent = bits.read(1)
				const useDelta = usedByCurrent === 1 ? 1 : bits.read(1)

				if (usedByCurrent === null || useDelta === null) {
					return false
				}

				use.push(useDelta)
			}

			const s0: number[] = []
			const s1: number[] = []
			const negatives = previous.s0.length

			for (let j = previous.s1.length - 1; j >= 0; j--) {
				const poc = (previous.s1[j] ?? 0) + deltaRps

				if (poc < 0 && use[negatives + j] === 1) {
					s0.push(poc)
				}
			}

			if (deltaRps < 0 && use[deltas] === 1) {
				s0.push(deltaRps)
			}

			for (let j = 0; j < negatives; j++) {
				const poc = (previous.s0[j] ?? 0) + deltaRps

				if (poc < 0 && use[j] === 1) {
					s0.push(poc)
				}
			}

			for (let j = negatives - 1; j >= 0; j--) {
				const poc = (previous.s0[j] ?? 0) + deltaRps

				if (poc > 0 && use[j] === 1) {
					s1.push(poc)
				}
			}

			if (deltaRps > 0 && use[deltas] === 1) {
				s1.push(deltaRps)
			}

			for (let j = 0; j < previous.s1.length; j++) {
				const poc = (previous.s1[j] ?? 0) + deltaRps

				if (poc > 0 && use[negatives + j] === 1) {
					s1.push(poc)
				}
			}

			previous = { s0, s1 }

			continue
		}

		const negative = bits.ue()
		const positive = bits.ue()

		if (negative === null || positive === null || negative > 16 || positive > 16) {
			return false
		}

		const s0: number[] = []
		const s1: number[] = []

		for (let i = 0; i < negative + positive; i++) {
			const delta = bits.ue()

			if (delta === null || bits.read(1) === null) {
				return false
			}

			if (i < negative) {
				s0.push((s0[i - 1] ?? 0) - (delta + 1))
			} else {
				s1.push((s1[i - negative - 1] ?? 0) + delta + 1)
			}
		}

		previous = { s0, s1 }
	}

	return true
}

// The rest of an HEVC SPS up to its VUI; false when it cannot be walked.
function skipToHevcVui(bits: BitReader, maxSubLayersMinus1: number): boolean {
	const pocBits = bits.ue()

	if (pocBits === null || pocBits > 12) {
		return false
	}

	for (let i = bits.read(1) === 1 ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
		bits.ue()
		bits.ue()
		bits.ue()
	}

	for (let i = 0; i < 6; i++) {
		bits.ue()
	}

	if (bits.read(1) === 1 && bits.read(1) === 1 && !skipHevcScalingListData(bits)) {
		return false
	}

	bits.read(2)

	if (bits.read(1) === 1) {
		bits.read(8)
		bits.ue()
		bits.ue()
		bits.read(1)
	}

	const sets = bits.ue()

	if (sets === null || sets > 64 || !skipShortTermRefPicSets(bits, sets)) {
		return false
	}

	if (bits.read(1) === 1) {
		const longTerm = bits.ue()

		if (longTerm === null || longTerm > 32) {
			return false
		}

		for (let i = 0; i < longTerm; i++) {
			bits.read(pocBits + 4)
			bits.read(1)
		}
	}

	bits.read(2)

	return bits.read(1) === 1
}

// seq_parameter_set_rbsp() of an HEVC SPS NAL unit (2-byte header included, emulation prevention not removed).
export function parseHevcSps(nal: Uint8Array): HevcSps | null {
	if ((((nal[0] ?? 0) >> 1) & 0x3f) !== 33 || nal.length < 16) {
		return null
	}

	const bits = new BitReader(unescapeRbsp(nal.subarray(2)))

	bits.read(4)

	const maxSubLayersMinus1 = bits.read(3) ?? 0

	bits.read(1)

	const first = bits.read(8)
	const compatibility = bits.read(32)
	const constraints: number[] = []

	for (let i = 0; i < 6; i++) {
		constraints.push(bits.read(8) ?? 0)
	}

	const level = bits.read(8)

	if (first === null || compatibility === null || level === null) {
		return null
	}

	const present: [number, number][] = []

	for (let i = 0; i < maxSubLayersMinus1; i++) {
		present.push([bits.read(1) ?? 0, bits.read(1) ?? 0])
	}

	if (maxSubLayersMinus1 > 0) {
		bits.skip(2 * (8 - maxSubLayersMinus1))
	}

	for (const [profilePresent, levelPresent] of present) {
		bits.skip(profilePresent * 88 + levelPresent * 8)
	}

	bits.ue()

	let chroma = bits.ue()

	if (chroma === null || chroma > 3) {
		return null
	}

	if (chroma === 3 && bits.read(1) === 1) {
		chroma = 0
	}

	const width = bits.ue()
	const height = bits.ue()

	if (width === null || height === null) {
		return null
	}

	const crop = bits.read(1) === 1 ? readCrop(bits) : [0, 0, 0, 0]
	const luma = bits.ue()

	if (crop === null || luma === null || luma > 8 || bits.ue() === null) {
		return null
	}

	const size = croppedSize(width, height, crop, chroma === 1 || chroma === 2 ? 2 : 1, chroma === 1 ? 2 : 1)

	if (size === null) {
		return null
	}

	const vui = skipToHevcVui(bits, maxSubLayersMinus1) ? readVui(bits, false) : { par: 1, transfer: null, frameSeconds: null }

	return {
		profileSpace: first >> 6,
		tier: (first >> 5) & 1,
		profile: first & 0x1f,
		compatibility,
		constraints,
		level,
		width: size[0],
		height: size[1],
		bitDepth: luma + 8,
		par: vui.par,
		transfer: vui.transfer
	}
}

// ── Audio ────────────────────────────────────────────────────────────────────

export interface AacConfig {
	// The object type the codec string names: 5 (SBR) or 29 (PS) when signalled, else the core type.
	objectType: number
	sampleRate: number | null
	channels: number | null
}

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
const AAC_CHANNELS: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 8, 11: 7, 12: 8, 13: 24, 14: 8 }

function aacObjectType(bits: BitReader): number | null {
	const type = bits.read(5)

	if (type !== 31) {
		return type
	}

	const escaped = bits.read(6)

	return escaped === null ? null : 32 + escaped
}

function aacSampleRate(bits: BitReader): number | null {
	const index = bits.read(4)

	if (index === 0x0f) {
		return bits.read(24)
	}

	return index === null ? null : (AAC_SAMPLE_RATES[index] ?? null)
}

// Object types whose config is a GASpecificConfig.
const GA_OBJECT_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23])

// Skips a GASpecificConfig; false when it holds a program config element this reader does not walk.
function skipGaSpecificConfig(bits: BitReader, objectType: number, channelConfiguration: number): boolean {
	if (channelConfiguration === 0) {
		return false
	}

	bits.read(1)

	if (bits.read(1) === 1) {
		bits.read(14)
	}

	const extension = bits.read(1)

	if (objectType === 6 || objectType === 20) {
		bits.read(3)
	}

	if (extension === 1) {
		if (objectType === 22) {
			bits.read(16)
		}

		if (objectType === 17 || objectType === 19 || objectType === 20 || objectType === 23) {
			bits.read(3)
		}

		bits.read(1)
	}

	return true
}

// AudioSpecificConfig: an esds DecoderSpecificInfo, or a Matroska A_AAC CodecPrivate.
export function parseAudioSpecificConfig(config: Uint8Array): AacConfig | null {
	const bits = new BitReader(config)
	let objectType = aacObjectType(bits)
	let sampleRate = aacSampleRate(bits)
	const channelConfiguration = bits.read(4)

	if (objectType === null || objectType === 0 || sampleRate === null || channelConfiguration === null) {
		return null
	}

	const channels = AAC_CHANNELS[channelConfiguration] ?? null

	// Explicit hierarchical signalling: the SBR/PS type first, then the output rate and the core type.
	if (objectType === 5 || objectType === 29) {
		const extensionRate = aacSampleRate(bits)
		const core = aacObjectType(bits)

		return core === null ? null : { objectType, sampleRate: extensionRate ?? sampleRate, channels: objectType === 29 ? 2 : channels }
	}

	// Backward-compatible signalling: a sync extension after the core config.
	if (GA_OBJECT_TYPES.has(objectType) && skipGaSpecificConfig(bits, objectType, channelConfiguration) && bits.left >= 16) {
		if (bits.read(11) === 0x2b7 && aacObjectType(bits) === 5 && bits.read(1) === 1) {
			sampleRate = aacSampleRate(bits) ?? sampleRate
			objectType = 5

			if (bits.left >= 12 && bits.read(11) === 0x548 && bits.read(1) === 1) {
				objectType = 29
			}
		}
	}

	return { objectType, sampleRate, channels: objectType === 29 ? 2 : channels }
}

// An MP4 audio track's string from its esds objectTypeIndication and, for MPEG-4 audio, its AudioSpecificConfig.
export function mp4aCodecString({
	objectTypeIndication,
	audioSpecificConfig
}: {
	objectTypeIndication: number
	audioSpecificConfig: Uint8Array | null
}): string | null {
	switch (objectTypeIndication) {
		case 0x40: {
			const config = audioSpecificConfig === null ? null : parseAudioSpecificConfig(audioSpecificConfig)

			return config === null ? null : `mp4a.40.${String(config.objectType)}`
		}

		case 0x66:
		case 0x67:
		case 0x68:
		case 0x69:
		case 0x6b:
			return `mp4a.${hex(objectTypeIndication, 2).toUpperCase()}`
		case 0xa5:
			return "ac-3"
		case 0xa6:
			return "ec-3"
		case 0xa9:
			return "dtsc"
		case 0xaa:
			return "dtsh"
		case 0xab:
			return "dtsl"
		case 0xac:
			return "dtse"
		case 0xad:
			return "opus"
		default:
			return null
	}
}

// Matroska's legacy A_AAC/<version>/<profile> IDs from before CodecPrivate carried the config.
// A Map, so a codec ID never resolves an inherited object key.
const MATROSKA_AAC_PROFILES: ReadonlyMap<string, number> = new Map([
	["MAIN", 1],
	["LC", 2],
	["SSR", 3],
	["LTP", 4],
	["LC/SBR", 5]
])

export function matroskaAacCodecString({ codecId, codecPrivate }: { codecId: string; codecPrivate: Uint8Array | null }): string | null {
	if (codecPrivate !== null && codecPrivate.length >= 2) {
		return mp4aCodecString({ objectTypeIndication: 0x40, audioSpecificConfig: codecPrivate })
	}

	const profile = MATROSKA_AAC_PROFILES.get(codecId.replace(/^A_AAC\/MPEG[24]\//, ""))

	return profile === undefined ? null : `mp4a.40.${String(profile)}`
}

export type SimpleAudioCodec = "mp3" | "opus" | "flac" | "vorbis" | "ac3" | "eac3" | "truehd" | "alac"

const SIMPLE_AUDIO: Readonly<Record<SimpleAudioCodec, string>> = {
	mp3: "mp4a.6B",
	opus: "opus",
	flac: "flac",
	vorbis: "vorbis",
	ac3: "ac-3",
	eac3: "ec-3",
	truehd: "mlpa",
	alac: "alac"
}

// Codecs whose string carries nothing from their config.
export function simpleAudioCodecString(codec: SimpleAudioCodec): string {
	return SIMPLE_AUDIO[codec]
}

// DTS by its MP4 sample entry type or Matroska CodecID: core, Express (LBR), HD High Resolution, HD Master Audio.
export function dtsCodecString(name: string): string | null {
	switch (name) {
		case "dtsc":
		case "A_DTS":
			return "dtsc"
		case "dtse":
		case "A_DTS/EXPRESS":
			return "dtse"
		case "dtsh":
			return "dtsh"
		case "dtsl":
		case "A_DTS/LOSSLESS":
			return "dtsl"
		default:
			return null
	}
}

// ── Dolby Vision ─────────────────────────────────────────────────────────────

// Dolby Vision sample entries by the base codec's: hvc1 → dvh1, hev1 → dvhe, av01 → dav1, avc1 → dva1,
// avc3 → dvav. A Matroska track is written as a remux would write it, else under its raw codec ID,
// so this is a Map: no ID resolves an inherited object key.
const DOLBY_VISION_ENTRIES: ReadonlyMap<string, string> = new Map([
	["hvc1", "dvh1"],
	["hev1", "dvhe"],
	["dvh1", "dvh1"],
	["dvhe", "dvhe"],
	["av01", "dav1"],
	["dav1", "dav1"],
	["avc1", "dva1"],
	["avc3", "dvav"],
	["dva1", "dva1"],
	["dvav", "dvav"]
])

// The Dolby Vision string (dvh1.PP.LL) a decoder must accept when the stream has no base layer that
// plays without Dolby Vision; null for a sample entry type that carries no Dolby Vision.
export function dolbyVisionCodecString({ fourcc, profile, level }: { fourcc: string; profile: number; level: number }): string | null {
	const entry = DOLBY_VISION_ENTRIES.get(fourcc)

	return entry === undefined ? null : `${entry}.${dec(profile, 2)}.${dec(level, 2)}`
}

// ── Equivalent spellings ─────────────────────────────────────────────────────

// Strings browsers answer differently for the same codec: Firefox accepts MP3 in MP4 only as "mp3",
// others only as an object type; FLAC and Opus have sample-entry spellings; AC-3/E-AC-3 have object types.
const EQUIVALENT_CODEC_STRINGS: readonly (readonly string[])[] = [
	["mp4a.6B", "mp4a.69", "mp3", "mp4a.6b"],
	["flac", "fLaC"],
	["opus", "Opus"],
	["ac-3", "mp4a.a5", "mp4a.A5"],
	["ec-3", "mp4a.a6", "mp4a.A6"]
]

// `codecString` first, then every spelling a capability query may also try for it.
export function codecStringAlternatives(codecString: string): string[] {
	const group = EQUIVALENT_CODEC_STRINGS.find(spellings => spellings.includes(codecString))

	return group === undefined ? [codecString] : [codecString, ...group.filter(spelling => spelling !== codecString)]
}
