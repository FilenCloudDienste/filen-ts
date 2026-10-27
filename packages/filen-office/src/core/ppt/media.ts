import type { LinkedPart } from "../opc/package"
import { children, u32, utf16Text, type PptRecord, type RecordCounter } from "./records"
import type { PptSound } from "./transitions"
import { xmlText } from "./text"

// Sounds and movies ([MS-PPT] §2.4.16 SoundCollectionContainer, §2.10.4–§2.10.9 and §2.10.25–§2.10.33) as
// PresentationML media (ECMA-376 Part 1 §20.1.3.1–§20.1.3.6 on the picture shape's p:nvPr): an embedded sound becomes
// an audio part (a:wavAudioFile), a linked movie or sound a link the reader never fetches (a:videoFile, a:audioFile),
// a CD track its range (a:audioCd). Sounds a transition or an animation plays are the same audio parts.

const RT = {
	cString: 0x0fba,
	document: 0x03e8,
	soundCollection: 0x07e4,
	sound: 0x07e6,
	soundData: 0x07e7,
	externalObjectList: 0x0409,
	mediaAtom: 0x1004,
	video: 0x1005,
	aviMovie: 0x1006,
	mciMovie: 0x1007,
	midiAudio: 0x100d,
	cdAudio: 0x100e,
	wavEmbedded: 0x100f,
	wavLink: 0x1010,
	cdAudioAtom: 0x1012,
	wavEmbeddedAtom: 0x1013
} as const

export type PptMediaSource =
	| { readonly kind: "sound"; readonly soundIdRef: number }
	| { readonly kind: "linked"; readonly path: string }
	| { readonly kind: "cd"; readonly start: number; readonly end: number }

export interface PptMediaObject {
	readonly kind: "audio" | "video"
	readonly source: PptMediaSource
}

interface SoundEntry {
	readonly name: string
	readonly extension: string
	readonly start: number
	readonly end: number
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	aif: "audio/x-aiff",
	aiff: "audio/x-aiff",
	mid: "audio/midi"
}

// A path a file names (§2.10.7 UncOrLocalPath) as a file URI: drive and UNC paths absolute, others relative. An
// unpaired surrogate (which encodeURIComponent refuses; a pair is one code point to the u flag) is U+FFFD.
export function pathUri(path: string): string {
	const slashed = path.replaceAll("\\", "/").replace(/[\ud800-\udfff]/gu, "\ufffd")
	const encoded = slashed
		.split("/")
		.map(segment => encodeURIComponent(segment).replaceAll("%3A", ":"))
		.join("/")

	if (/^[A-Za-z]:\//u.test(slashed)) return `file:///${encoded}`
	if (slashed.startsWith("//")) return `file:${encoded}`

	return encoded
}

function cString(data: Uint8Array, record: PptRecord): string {
	return utf16Text(data, record.start, record.end)
}

// §2.10.6 ExMediaAtom: its exObjId.
function mediaId(data: Uint8Array, kids: readonly PptRecord[]): number | undefined {
	const atom = kids.find(record => record.type === RT.mediaAtom)

	return atom === undefined || atom.end - atom.start < 4 ? undefined : u32(data, atom.start)
}

export class PptMedia {
	private sounds: Map<number, SoundEntry> | undefined
	private objects: Map<number, PptMediaObject> | undefined
	private readonly soundParts = new Map<number, string>()
	private readonly parts = new Map<string, LinkedPart>()

	private readonly data: Uint8Array
	// The DocumentContainer's children.
	private readonly document: readonly PptRecord[]
	private readonly counter: RecordCounter

	constructor(data: Uint8Array, document: readonly PptRecord[], counter: RecordCounter) {
		this.data = data
		this.document = document
		this.counter = counter
	}

	private kids(record: PptRecord): PptRecord[] {
		return children(this.data, record.start, record.end, this.counter)
	}

	// §2.4.16.1: the deck's embedded sounds by sound id.
	private soundEntries(): Map<number, SoundEntry> {
		if (this.sounds !== undefined) return this.sounds

		const out = new Map<number, SoundEntry>()
		const collection = this.document.find(record => record.type === RT.soundCollection)

		for (const sound of collection === undefined ? [] : this.kids(collection)) {
			if (sound.type !== RT.sound) continue

			const entry = this.soundEntry(sound)

			if (entry !== undefined && !out.has(entry.id)) out.set(entry.id, entry.sound)
		}

		this.sounds = out

		return out
	}

	private soundEntry(container: PptRecord): { readonly id: number; readonly sound: SoundEntry } | undefined {
		let name = ""
		let extension = ".wav"
		let id = 0
		let blob: PptRecord | undefined

		for (const child of this.kids(container)) {
			if (child.type === RT.soundData) blob = child
			else if (child.type === RT.cString) {
				if (child.instance === 0) name = cString(this.data, child)
				else if (child.instance === 1) extension = cString(this.data, child)
				else if (child.instance === 2) id = Number.parseInt(cString(this.data, child), 10)
			}
		}

		if (blob === undefined) return undefined

		return { id: Number.isFinite(id) ? id : 0, sound: { name, extension, start: blob.start, end: blob.end } }
	}

	private partOf(key: number, entry: SoundEntry): string {
		const held = this.soundParts.get(key)

		if (held !== undefined) return held

		const extension = entry.extension.replace(/^\./u, "").toLowerCase()
		const known = extension === "wave" ? "wav" : extension in CONTENT_TYPES ? extension : "wav"
		const name = `ppt/media/audio${String(this.soundParts.size + 1)}.${known}`
		const bytes = this.data.subarray(entry.start, entry.end)

		this.soundParts.set(key, name)
		this.parts.set(name, { size: bytes.length, read: () => Promise.resolve(bytes) })

		return name
	}

	// The audio part of sound `soundIdRef` (§2.2.27; 0 is none), undefined when the deck has no such sound.
	soundPart(soundIdRef: number): { readonly part: string; readonly name: string } | undefined {
		if (soundIdRef === 0) return undefined

		const entry = this.soundEntries().get(soundIdRef)

		return entry === undefined ? undefined : { part: this.partOf(soundIdRef, entry), name: entry.name }
	}

	// A sound embedded in an AnimationInfoContainer, as an audio part of its own.
	embeddedSoundPart(container: PptRecord): { readonly part: string; readonly name: string } | undefined {
		const entry = this.soundEntry(container)

		if (entry === undefined) return undefined

		// Keyed apart from the collection's ids (which are positive) by the record's place.
		return { part: this.partOf(-1 - container.start, entry.sound), name: entry.sound.name }
	}

	// A sound as a relationship of a part: `add` gives the relationship id of a target relative to ppt/<dir>/.
	sound(soundIdRef: number, add: (type: string, target: string) => string): PptSound | undefined {
		const held = this.soundPart(soundIdRef)

		return held === undefined
			? undefined
			: { rId: add("audio", `../media/${held.part.slice(held.part.lastIndexOf("/") + 1)}`), name: held.name }
	}

	// §2.10.1: the deck's movies and sounds by exObjId.
	mediaObject(exObjId: number): PptMediaObject | undefined {
		if (this.objects === undefined) {
			this.objects = new Map()

			const list = this.document.find(record => record.type === RT.externalObjectList)

			for (const record of list === undefined ? [] : this.kids(list)) this.readObject(record, this.objects)
		}

		return this.objects.get(exObjId)
	}

	private readObject(record: PptRecord, into: Map<number, PptMediaObject>): void {
		const data = this.data

		switch (record.type) {
			case RT.aviMovie:
			case RT.mciMovie: {
				const video = this.kids(record).find(child => child.type === RT.video)

				if (video !== undefined) this.readObject(video, into)

				return
			}
			case RT.video:
			case RT.midiAudio:
			case RT.wavLink: {
				const kids = this.kids(record)
				const id = mediaId(data, kids)
				const path = kids.find(child => child.type === RT.cString)

				if (id !== undefined && path !== undefined && !into.has(id)) {
					into.set(id, {
						kind: record.type === RT.video ? "video" : "audio",
						source: { kind: "linked", path: cString(data, path) }
					})
				}

				return
			}
			case RT.wavEmbedded: {
				const kids = this.kids(record)
				const id = mediaId(data, kids)
				const atom = kids.find(child => child.type === RT.wavEmbeddedAtom)

				if (id !== undefined && atom !== undefined && atom.end - atom.start >= 4 && !into.has(id))
					into.set(id, { kind: "audio", source: { kind: "sound", soundIdRef: u32(data, atom.start) } })

				return
			}
			case RT.cdAudio: {
				const kids = this.kids(record)
				const id = mediaId(data, kids)
				const atom = kids.find(child => child.type === RT.cdAudioAtom)

				if (id !== undefined && atom !== undefined && atom.end - atom.start >= 8 && !into.has(id))
					into.set(id, { kind: "audio", source: { kind: "cd", start: u32(data, atom.start), end: u32(data, atom.start + 4) } })

				return
			}
			default:
				return
		}
	}

	// The media element of a picture shape's p:nvPr for movie or sound `exObjId`; undefined when it is not one.
	nvPrXml(exObjId: number, add: (type: string, target: string, external?: boolean) => string): string | undefined {
		const object = this.mediaObject(exObjId)

		if (object === undefined) return undefined

		const source = object.source

		switch (source.kind) {
			case "linked": {
				if (source.path === "") return undefined

				const id = add(object.kind, pathUri(source.path), true)

				return object.kind === "video" ? `<a:videoFile r:link="${id}"/>` : `<a:audioFile r:link="${id}"/>`
			}
			case "sound": {
				const held = this.soundPart(source.soundIdRef)

				if (held === undefined) return undefined

				return `<a:wavAudioFile r:embed="${add("audio", `../media/${held.part.slice(held.part.lastIndexOf("/") + 1)}`)}" name="${xmlText(held.name)}"/>`
			}
			case "cd": {
				// §2.12.10 TmsfTimeStruct: track, minute, second, frame (75 frames a second).
				const time = (value: number): string => {
					const seconds = ((value >>> 8) & 0xff) * 60 + ((value >>> 16) & 0xff) + ((value >>> 24) & 0xff) / 75

					return `track="${String(Math.max(0, Math.min(255, value & 0xff)))}" time="${String(Math.round(seconds))}"`
				}

				return `<a:audioCd><a:st ${time(source.start)}/><a:end ${time(source.end)}/></a:audioCd>`
			}
		}
	}

	// The audio parts written, by name, and their content types by extension.
	finish(parts: Map<string, Uint8Array | LinkedPart>, defaults: Map<string, string>): void {
		for (const [name, part] of this.parts) {
			const extension = name.slice(name.lastIndexOf(".") + 1)

			parts.set(name, part)
			defaults.set(extension, CONTENT_TYPES[extension] ?? "audio/wav")
		}
	}
}
