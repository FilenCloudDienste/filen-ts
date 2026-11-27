import { concat, text, u16, u32 } from "@/tests/support/containerBytes"

// A HEIF/AVIF file for sniffer and metadata tests: ftyp, meta (pitm, iinf, iloc, iref, iprp, idat), mdat. Item 1 is
// the primary image, 2 the Exif, 3 the alpha plane.

const ascii = (value: string): number[] => text(value)
const u16be = u16
const u32be = u32

function box(type: string, ...content: (Uint8Array | readonly number[])[]): Uint8Array {
	const body = concat(...content)

	return concat(u32be(body.length + 8), ascii(type), body)
}

const fullBox = (type: string, version: number, flags: number, ...content: (Uint8Array | readonly number[])[]) =>
	box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...content)

export interface HeifSpec {
	major: string
	compatible: string[]
	primaryType: string
	icc?: Uint8Array
	nclx?: boolean
	irot?: number
	alpha?: boolean
	exif?: Uint8Array
	ilocVersion?: 0 | 1
	exifInIdat?: boolean
}

export function heif(spec: HeifSpec): Uint8Array {
	const ftyp = box("ftyp", ascii(spec.major), u32be(0), ...spec.compatible.map(ascii))
	const exifPayload = spec.exif === undefined ? null : concat(u32be(0), spec.exif)
	const items = [
		fullBox("infe", 2, 0, u16be(1), u16be(0), ascii(spec.primaryType), [0]),
		...(exifPayload === null ? [] : [fullBox("infe", 2, 0, u16be(2), u16be(0), ascii("Exif"), [0])]),
		...(spec.alpha === true ? [fullBox("infe", 2, 0, u16be(3), u16be(0), ascii(spec.primaryType), [0])] : [])
	]
	const properties: Uint8Array[] = [fullBox("ispe", 0, 0, u32be(1200), u32be(800))]
	const primaryProps = [1]

	if (spec.icc !== undefined) {
		properties.push(box("colr", ascii("prof"), spec.icc))
		primaryProps.push(properties.length)
	}

	if (spec.nclx === true) {
		properties.push(box("colr", ascii("nclx"), [0, 12, 0, 13, 0, 1, 0x80]))
		primaryProps.push(properties.length)
	}

	if (spec.irot !== undefined) {
		properties.push(box("irot", [spec.irot]))
		primaryProps.push(properties.length)
	}

	const alphaProps: number[] = []

	if (spec.alpha === true) {
		properties.push(fullBox("auxC", 0, 0, ascii("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0")))
		alphaProps.push(1, properties.length)
	}

	const ipma = fullBox(
		"ipma",
		0,
		0,
		u32be(spec.alpha === true ? 2 : 1),
		u16be(1),
		[primaryProps.length],
		primaryProps.map(i => 0x80 | i),
		...(spec.alpha === true ? [u16be(3), [alphaProps.length], alphaProps] : [])
	)

	const buildMeta = (exifOffset: number) => {
		const version = spec.ilocVersion ?? 0
		const method = spec.exifInIdat === true ? 1 : 0
		const location =
			exifPayload === null
				? []
				: [u16be(2), ...(version === 1 ? [u16be(method)] : []), u16be(0), u16be(1), u32be(exifOffset), u32be(exifPayload.length)]
		const iloc = fullBox("iloc", version, 0, [0x44, 0x00], u16be(exifPayload === null ? 0 : 1), ...location)

		return fullBox(
			"meta",
			0,
			0,
			fullBox("hdlr", 0, 0, u32be(0), ascii("pict"), new Uint8Array(13)),
			fullBox("pitm", 0, 0, u16be(1)),
			fullBox("iinf", 0, 0, u16be(items.length), ...items),
			iloc,
			...(spec.alpha === true ? [fullBox("iref", 0, 0, box("auxl", u16be(3), u16be(1), u16be(1)))] : []),
			box("iprp", box("ipco", ...properties), ipma),
			...(spec.exifInIdat === true && exifPayload !== null ? [box("idat", exifPayload)] : [])
		)
	}

	const mdatData = spec.exifInIdat === true || exifPayload === null ? new Uint8Array(4) : exifPayload
	const metaLength = buildMeta(0).length
	const meta = buildMeta(spec.exifInIdat === true ? 0 : ftyp.length + metaLength + 8)

	return concat(ftyp, meta, box("mdat", mdatData))
}
