import { crc32, deflateSync } from "node:zlib"
import { cfbBytes } from "../core/cfb/index"
import { Rc4 } from "../core/crypto/legacy"
import { cryptoApiKeys, encryptionHeader } from "./docDecryptFixtures"

// Synthetic PowerPoint 97–2003 files ([MS-PPT] §2.1–§2.9, MS-ODRAW §2.2) written record by record: a document with a
// main master and slides of shapes with text, optionally an incremental second edit, a picture, and RC4 CryptoAPI
// encryption (§2.3.7). Built to the spec so every reader path has a file that exercises it without the corpus.

export interface FixtureShape {
	readonly text?: string
	// TextHeaderAtom type (§2.13.32), default 4 (other).
	readonly textType?: number
	// PlaceholderAtom placementId (§2.13.21) and position.
	readonly placeholder?: { readonly type: number; readonly position: number }
	// top, left, right, bottom in master units.
	readonly anchor: readonly [number, number, number, number]
	readonly shapeType?: number
	// OfficeArt properties (pid → value).
	readonly properties?: readonly (readonly [number, number])[]
	// Index of the slide list's text body (OutlineTextRefAtom) instead of inline text.
	readonly outline?: number
	// The picture of BLIP store entry 1.
	readonly picture?: boolean
	// StyleTextPropAtom bytes to write as they are (hostile input).
	readonly rawStyle?: Uint8Array
	// A mouse-click InteractiveInfo (§2.6.7): InteractiveInfoAtom action and oleVerb, and its MacroNameAtom.
	readonly click?: { readonly action: number; readonly oleVerb?: number; readonly name?: string }
	// More records of the shape's OfficeArtClientData (an AnimationInfoContainer, an ExObjRefAtom).
	readonly clientData?: readonly Uint8Array[]
	// FSP fOleShape (MS-ODRAW §2.2.40): the shape shows an OLE object.
	readonly oleShape?: boolean
	// FSP fFlipH.
	readonly flipH?: boolean
}

export interface FixtureSlide {
	readonly shapes: readonly FixtureShape[]
	readonly hidden?: boolean
	// Bodies of text in the slide list after the slide's persist atom.
	readonly outline?: readonly { readonly type: number; readonly text: string }[]
	// More records of the SlideContainer (a SlideShowSlideInfoAtom, a SlideProgTagsContainer).
	readonly records?: readonly Uint8Array[]
}

export interface FixtureOptions {
	readonly slides: readonly FixtureSlide[]
	// A second user edit that replaces slide `index` with `slide` (the first edit's object stays, dead).
	readonly edit?: { readonly index: number; readonly slide: FixtureSlide }
	readonly password?: string
	readonly keySize?: number
	// A PNG in the Pictures stream, referenced by pib 1.
	readonly png?: Uint8Array
	// BLIP store entries written as they are (replaces the png entry), and Pictures stream bytes (hostile input).
	readonly store?: readonly Uint8Array[]
	readonly picturesStream?: Uint8Array
	// More records of the DocumentContainer (an ExObjListContainer, a SoundCollectionContainer).
	readonly documentRecords?: readonly Uint8Array[]
	// More persist objects by persist id (100 and up; an ExOleObjStg).
	readonly objects?: ReadonlyMap<number, Uint8Array>
	// The main master's shapes (spids from 0x401), in place of its title and body placeholders.
	readonly masterShapes?: readonly FixtureShape[]
	// The main master's background shape properties (pid → value), in place of a fill of scheme colour 0.
	readonly masterBackground?: readonly (readonly [number, number])[]
	// The drawing group's default properties (OfficeArtDggContainer drawingPrimaryOptions), in place of fill colour
	// scheme 4 and line colour scheme 1.
	readonly drawingDefaults?: readonly (readonly [number, number])[]
}

function u16(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff)
}

function u32(value: number): Uint8Array {
	return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

export function record(type: number, data: Uint8Array, instance = 0, version = 0): Uint8Array {
	return concat(u16((instance << 4) | version), u16(type), u32(data.length), data)
}

export function container(type: number, children: readonly Uint8Array[], instance = 0): Uint8Array {
	return record(type, concat(...children), instance, 0xf)
}

function utf16(text: string): Uint8Array {
	const out = new Uint8Array(text.length * 2)

	for (let k = 0; k < text.length; k++) {
		out[2 * k] = text.charCodeAt(k) & 0xff
		out[2 * k + 1] = text.charCodeAt(k) >>> 8
	}

	return out
}

// StyleTextPropAtom: one paragraph run and one character run over the whole text, the characters 18 pt.
function style(text: string): Uint8Array {
	const count = text.length + 1

	return record(0x0fa1, concat(u32(count), u16(0), u32(0), u32(count), u32(0x20000), u16(18)))
}

function textRecords(type: number, text: string, raw?: Uint8Array): Uint8Array[] {
	return [record(0x0f9f, u32(type)), record(0x0fa0, utf16(text)), raw === undefined ? style(text) : record(0x0fa1, raw)]
}

function properties(entries: readonly (readonly [number, number])[]): Uint8Array {
	return record(0xf00b, concat(...entries.map(([pid, value]) => concat(u16(pid), u32(value)))), entries.length, 3)
}

function shapeContainer(shape: FixtureShape, spid: number): Uint8Array {
	const [top, left, right, bottom] = shape.anchor
	const children: Uint8Array[] = [
		record(
			0xf00a,
			concat(u32(spid), u32(0xa00 | (shape.oleShape === true ? 0x10 : 0) | (shape.flipH === true ? 0x40 : 0))),
			shape.shapeType ?? (shape.picture === true ? 75 : 1),
			2
		),
		properties([...(shape.properties ?? []), ...(shape.picture === true ? ([[0x4104, 1]] as const) : [])]),
		record(0xf010, concat(u16(top), u16(left), u16(right), u16(bottom)))
	]

	const client: Uint8Array[] = []

	if (shape.placeholder !== undefined) {
		client.push(record(0x0bc3, concat(u32(shape.placeholder.position), Uint8Array.of(shape.placeholder.type, 0), u16(0))))
	}

	if (shape.click !== undefined) {
		const atom = record(0x0ff3, concat(u32(0), u32(0), Uint8Array.of(shape.click.action, shape.click.oleVerb ?? 0, 0, 0, 0, 0, 0, 0)))
		const name = shape.click.name === undefined ? [] : [record(0x0fba, utf16(shape.click.name), 2)]

		client.push(container(0x0ff2, [atom, ...name]))
	}

	client.push(...(shape.clientData ?? []))

	if (client.length > 0) children.push(container(0xf011, client))

	if (shape.outline !== undefined) children.push(container(0xf00d, [record(0x0f9e, u32(shape.outline))]))
	else if (shape.text !== undefined) children.push(container(0xf00d, textRecords(shape.textType ?? 4, shape.text, shape.rawStyle)))

	return container(0xf004, children)
}

function drawing(shapes: readonly FixtureShape[], firstSpid: number, background: readonly (readonly [number, number])[]): Uint8Array {
	const patriarch = container(0xf004, [record(0xf009, new Uint8Array(16), 0, 1), record(0xf00a, concat(u32(firstSpid), u32(0x5)), 0, 2)])
	const members = shapes.map((shape, index) => shapeContainer(shape, firstSpid + 1 + index))
	const backgroundShape = container(0xf004, [
		record(0xf00a, concat(u32(firstSpid + shapes.length + 1), u32(0xc00)), 1, 2),
		properties(background)
	])

	return container(0x040c, [
		container(0xf002, [
			record(0xf008, concat(u32(shapes.length + 2), u32(firstSpid + shapes.length + 1))),
			container(0xf003, [patriarch, ...members]),
			backgroundShape
		])
	])
}

function scheme(): Uint8Array {
	return record(
		0x07f0,
		concat(u32(0xffffff), u32(0x000000), u32(0x808080), u32(0x000000), u32(0x99cc00), u32(0xcc3333), u32(0xffcccc), u32(0xb2b2b2)),
		1
	)
}

function slideAtom(geom: number, masterIdRef: number, flags: number): Uint8Array {
	return record(0x03ef, concat(u32(geom), new Uint8Array(8), u32(masterIdRef), u32(0), u16(flags), u16(0)), 0, 2)
}

// TextMasterStyleAtom of one level: bullets off, the given font size.
function masterStyle(instance: number, size: number): Uint8Array {
	return record(0x0fa3, concat(u16(1), u32(0x1), u16(0), u32(0x20000), u16(size)), instance)
}

function slideRecord(slide: FixtureSlide, spidBase: number): Uint8Array {
	const show =
		slide.hidden === true
			? [record(0x03f9, concat(u32(0), u32(0), Uint8Array.of(0, 0), u16(0x4 | 0x1), Uint8Array.of(0, 0, 0, 0)))]
			: []

	return container(0x03ee, [
		slideAtom(1, 0x80000000, 0x7),
		...show,
		drawing(slide.shapes, spidBase, [
			[0x0181, 0x08000000],
			[0x01bf, 0x100010]
		]),
		scheme(),
		...(slide.records ?? [])
	])
}

// A 1 × 1 PNG (signature, IHDR, IDAT, IEND).
function png(): Uint8Array {
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const name = Uint8Array.from(type, c => c.charCodeAt(0))
		const crc = crc32(concat(name, data))

		return concat(
			Uint8Array.of(data.length >>> 24, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff),
			name,
			data,
			Uint8Array.of(crc >>> 24, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff)
		)
	}

	return concat(
		Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
		chunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0)),
		chunk("IDAT", new Uint8Array(deflateSync(Uint8Array.of(0, 0)))),
		chunk("IEND", new Uint8Array(0))
	)
}

// The PNG BLIP (MS-ODRAW §2.2.28: rgbUid1, tag 0xFF, the file) and its FBSE (§2.2.32).
function blip(data: Uint8Array): { readonly blip: Uint8Array; readonly fbse: (offset: number) => Uint8Array } {
	const body = concat(new Uint8Array(16).fill(7), Uint8Array.of(0xff), data)
	const blipRecord = record(0xf01e, body, 0x6e0, 0)

	return {
		blip: blipRecord,
		fbse: offset =>
			record(
				0xf007,
				concat(
					Uint8Array.of(6, 6),
					new Uint8Array(16).fill(7),
					u16(0xff),
					u32(blipRecord.length),
					u32(1),
					u32(offset),
					Uint8Array.of(0, 0, 0, 0)
				),
				6,
				2
			)
	}
}

export interface BuiltPpt {
	readonly bytes: Uint8Array
	// The PowerPoint Document stream before encryption.
	readonly plainStream: Uint8Array
	// Persist id → offset.
	readonly persist: ReadonlyMap<number, number>
}

export async function buildPpt(options: FixtureOptions): Promise<BuiltPpt> {
	if (options.password !== undefined && options.edit !== undefined) throw new Error("an encrypted file has one user edit (§2.3.7)")

	const slides = options.slides
	const picture = options.png === undefined ? undefined : blip(options.png)
	const list: Uint8Array[] = []

	slides.forEach((slide, index) => {
		list.push(record(0x03f3, concat(u32(3 + index), u32(0), u32(slide.outline?.length ?? 0), u32(256 + index), u32(0))))

		for (const body of slide.outline ?? []) list.push(...textRecords(body.type, body.text))
	})

	const documentRecord = container(0x03e8, [
		record(
			0x03e9,
			concat(u32(5760), u32(4320), u32(4320), u32(5760), u32(1), u32(2), u32(0), u32(0), u16(1), u16(0), Uint8Array.of(0, 0, 0, 0)),
			0,
			1
		),
		container(0x03f2, [
			container(0x07d5, [record(0x0fb7, concat(utf16("Arial"), new Uint8Array(64 - 10), Uint8Array.of(0, 0, 0, 0x22)), 0)]),
			masterStyle(4, 18)
		]),
		container(0x040b, [
			container(0xf000, [
				record(0xf006, concat(u32(0x400), u32(2), u32(1), u32(1))),
				...(options.store !== undefined
					? [container(0xf001, options.store, options.store.length)]
					: picture === undefined
						? []
						: [container(0xf001, [picture.fbse(0)], 1)]),
				properties(
					options.drawingDefaults ?? [
						[0x0181, 0x08000004],
						[0x01c0, 0x08000001]
					]
				)
			])
		]),
		container(0x0ff0, [record(0x03f3, concat(u32(2), u32(0), u32(0), u32(0x80000000), u32(0)))], 1),
		container(0x0ff0, list, 0),
		...(options.documentRecords ?? []),
		record(0x03ea, new Uint8Array(0))
	])
	const master = container(0x03f8, [
		slideAtom(1, 0, 0),
		masterStyle(0, 44),
		masterStyle(1, 32),
		drawing(
			options.masterShapes ?? [
				{ text: "Master title", textType: 0, placeholder: { type: 1, position: 0 }, anchor: [100, 300, 5400, 700] },
				{ text: "Master body", textType: 1, placeholder: { type: 2, position: 1 }, anchor: [900, 300, 5400, 4000] }
			],
			0x400,
			options.masterBackground ?? [
				[0x0181, 0x08000000],
				[0x01bf, 0x100010]
			]
		),
		scheme()
	])
	const objects = new Map<number, Uint8Array>([
		[1, documentRecord],
		[2, master]
	])

	slides.forEach((slide, index) => objects.set(3 + index, slideRecord(slide, 0x800 * (index + 2))))

	for (const [id, bytes] of options.objects ?? []) objects.set(id, bytes)

	let session: number | undefined

	if (options.password !== undefined) {
		session = 3 + slides.length
		objects.set(
			session,
			record(
				0x2f14,
				encryptionHeader({ scheme: "cryptoApiRc4", password: options.password, keySize: options.keySize ?? 128 }),
				0,
				0xf
			)
		)
	}

	const parts: Uint8Array[] = []
	const persist = new Map<number, number>()
	let size = 0
	const append = (bytes: Uint8Array): number => {
		const at = size

		parts.push(bytes)
		size += bytes.length

		return at
	}

	for (const [id, bytes] of objects) persist.set(id, append(bytes))

	const directory = (entries: readonly (readonly [number, number])[]): Uint8Array => {
		const out: Uint8Array[] = []

		for (const [id, offset] of entries) out.push(u32((1 << 20) | id), u32(offset))

		return record(0x1772, concat(...out))
	}
	const userEdit = (lastEdit: number, directoryAt: number): Uint8Array =>
		record(
			0x0ff5,
			concat(
				u32(256),
				u16(0),
				Uint8Array.of(0, 3),
				u32(lastEdit),
				u32(directoryAt),
				u32(1),
				u32(Math.max(...objects.keys())),
				u16(1),
				u16(0),
				...(session === undefined ? [] : [u32(session)])
			)
		)
	let directoryAt = append(directory([...persist]))
	let editAt = append(userEdit(0, directoryAt))

	if (options.edit !== undefined) {
		const id = 3 + options.edit.index
		const offset = append(slideRecord(options.edit.slide, 0x800 * (options.edit.index + 2)))

		persist.set(id, offset)
		directoryAt = append(directory([[id, offset]]))
		editAt = append(userEdit(editAt, directoryAt))
	}

	const stream = concat(...parts)
	const plainStream = stream.slice()

	if (options.password !== undefined) {
		const keys = cryptoApiKeys(options.password, options.keySize ?? 128)

		for (const [id, offset] of persist) {
			if (id === session) continue

			const length = objects.get(id)?.length ?? 0
			const cipher = new Rc4(keys(id))

			cipher.apply(stream, stream, offset, offset, length)
		}
	}

	const user = record(
		0x0ff6,
		concat(
			u32(0x14),
			u32(options.password === undefined ? 0xe391c05f : 0xf3d1c4df),
			u32(editAt),
			u16(4),
			u16(0x03f4),
			Uint8Array.of(3, 0),
			u16(0),
			Uint8Array.from("test", c => c.charCodeAt(0)),
			u32(8)
		)
	)
	const entries: { path: string[]; bytes: Uint8Array }[] = [
		{ path: ["Current User"], bytes: user },
		{ path: ["PowerPoint Document"], bytes: stream }
	]

	if (options.picturesStream !== undefined) entries.push({ path: ["Pictures"], bytes: options.picturesStream })
	if (picture !== undefined) {
		let pictures = picture.blip

		if (options.password !== undefined) {
			// §2.3.7: each field a key stream of block 0 (rh, rgbUid1, tag, the file).
			const key = cryptoApiKeys(options.password, options.keySize ?? 128)(0)
			const out = pictures.slice()

			for (const [from, length] of [
				[0, 8],
				[8, 16],
				[24, 1],
				[25, pictures.length - 25]
			] as const)
				new Rc4(key).apply(pictures, out, from, from, length)

			pictures = out
		}

		entries.push({ path: ["Pictures"], bytes: pictures })
	}

	return { bytes: await cfbBytes(entries), plainStream, persist }
}

export const FIXTURE_PNG = png()

// --- A deck holding every reader past the slides: a PowerPoint 2002 time tree and a comment in the PP10 tag, a
// transition with a sound, an Office 97 build, a linked movie, an embedded object with its storage, an embedded sound.

const cString = (instance: number, text: string): Uint8Array => record(0x0fba, utf16(text), instance)
const timeInt = (id: number, value: number): Uint8Array => record(0xf142, concat(Uint8Array.of(1), u32(value)), id)
const timeNode = (...children: Uint8Array[]): Uint8Array => container(0xf144, children, 1)

function timeNodeAtom(type: number, duration?: number): Uint8Array {
	return record(
		0xf127,
		concat(u32(0), u32(0), u32(type), u32(0), u32(0), u32(0), u32(duration ?? 0), u32(0x8 | (duration === undefined ? 0 : 0x10)))
	)
}

const timeTarget = (spid: number): Uint8Array => container(0xf13c, [record(0x2afb, concat(u32(0), u32(1), u32(spid), u32(0), u32(0)))])
const timeCondition = (instance: number, delay: number): Uint8Array =>
	container(0xf125, [record(0xf128, concat(u32(0), u32(0), u32(0), u32(delay)))], instance)

// The SlideProgTagsContainer of the rich deck's first slide: one click fading shape 1024 in and playing movie 1025, and
// a comment.
export const RICH_TAG = container(0x1388, [
	container(0x138a, [
		cString(0, "___PPT10"),
		record(
			0x138b,
			concat(
				timeNode(
					timeNodeAtom(0, -1),
					container(0xf13d, [timeInt(20, 9)]),
					timeNode(
						timeNodeAtom(1, -1),
						container(0xf13d, [timeInt(20, 4)]),
						timeNode(
							timeNodeAtom(0),
							timeCondition(1, -1),
							timeNode(
								timeNodeAtom(0),
								container(0xf13d, [timeInt(20, 1), timeInt(9, 10), timeInt(11, 1)]),
								timeNode(
									timeNodeAtom(3, 500),
									container(0xf12d, [
										record(0xf136, concat(u32(0x3), u32(0))),
										record(0xf142, concat(Uint8Array.of(3), utf16("fade")), 1),
										container(0xf12a, [record(0xf133, concat(u32(0), u32(0), u32(0), u32(0))), timeTarget(1024)])
									])
								),
								timeNode(timeNodeAtom(4, 500), timeTarget(1025), container(0xf13d, [timeInt(22, 50000)]))
							)
						)
					)
				),
				container(0x2ee0, [
					cString(0, "Ann"),
					cString(1, "Looks good"),
					cString(2, "A"),
					record(0x2ee1, concat(u32(1), ...[2020, 5, 1, 4, 10, 30, 0, 0].map(u16), u32(100), u32(200)))
				])
			)
		)
	])
])
// A SlideShowSlideInfoAtom: a 2 s automatic advance, a wipe with a sound.
export const RICH_TRANSITION = record(
	0x03f9,
	concat(u32(2000), u32(3), Uint8Array.of(2, 10), u16(0x1 | 0x10 | 0x400), Uint8Array.of(2, 0, 0, 0))
)
// An AnimationInfoContainer: a fly-in.
export const RICH_BUILD = container(0x1014, [
	record(
		0x0ff1,
		concat(Uint8Array.of(0, 0, 0, 0xfe, 0, 0x44, 0, 0), u32(0), u32(0), Uint8Array.of(1, 0, 0, 0, 1, 12, 0, 0, 0, 0, 0, 0)),
		0,
		1
	)
])
const RICH_STORAGE = Uint8Array.from({ length: 4096 }, (_, k) => (k * 31) % 251)

export function richDeck(): Promise<BuiltPpt> {
	return buildPpt({
		png: FIXTURE_PNG,
		slides: [
			{ shapes: [{ text: "Fly in", anchor: [100, 100, 2000, 600] }], records: [RICH_TRANSITION, RICH_TAG] },
			{
				shapes: [
					{ text: "Built", anchor: [100, 100, 2000, 600], clientData: [RICH_BUILD] },
					{ picture: true, anchor: [100, 100, 1000, 800], clientData: [record(0x0bc1, u32(1))] },
					{ picture: true, oleShape: true, anchor: [1000, 100, 2000, 800], clientData: [record(0x0bc1, u32(2))] },
					{ picture: true, anchor: [100, 900, 1000, 1600], clientData: [record(0x0bc1, u32(3))] }
				]
			}
		],
		documentRecords: [
			container(0x0409, [
				container(0x1006, [container(0x1005, [record(0x1004, concat(u32(1), u32(0))), cString(0, "C:\\clips\\intro.avi")])]),
				container(0x0fcc, [
					record(0x0fcd, concat(u32(0), u32(0))),
					record(0x0fc3, concat(u32(1), u32(0), u32(2), u32(3), u32(100), u32(0))),
					cString(2, "Excel.Sheet.8")
				]),
				container(0x100f, [record(0x1004, concat(u32(3), u32(0))), record(0x1013, concat(u32(3), u32(0), u32(0)))])
			]),
			container(
				0x07e4,
				[
					record(0x07e5, u32(3)),
					container(0x07e6, [
						cString(0, "Chime"),
						cString(1, ".wav"),
						cString(2, "3"),
						record(0x07e7, Uint8Array.of(82, 73, 70, 70))
					])
				],
				5
			)
		],
		objects: new Map([[100, record(0x1011, concat(u32(RICH_STORAGE.length), new Uint8Array(deflateSync(RICH_STORAGE))), 1)]])
	})
}
