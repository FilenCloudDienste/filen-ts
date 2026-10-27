import type { TimeNode, TimingTree } from "../../../anim/model"
import type { ByteChunks } from "../../../opc/index"
import { refused, type Deck, type MediaRef, type Refused, type ShapeNode, type SlideNode } from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import { cloneModel, findShape } from "../changes"
import type { InsertedImage, MediaOp, MediaPlayback, OpOf } from "../ops"
import { insertedImage, pictureFillOf, registerInsertedImage } from "./picture"
import { applyShape, isRefused } from "./shape"
import { applyTiming } from "./timing"

// The media ops on the model, in place. An inserted medium is a p:pic (ECMA-376 §19.3.1.37) holding the medium
// (`media`, part "inserted:<id>" until a save gives it one) and its poster as an inserted picture fill: the poster
// draws through the image registry like any inserted picture, while the medium's bytes stay where the worker
// registered them (a device file, a drive file's range port) and are streamed once more at save as a stored entry.
// Playback options live in the slide timing's media node for the shape (p:video/p:audio, §19.5.93/§19.5.1): volume,
// mute, hide while stopped, full screen, and loop as its repeat count.

export const INSERTED_MEDIA = "inserted:"

// The worker registry id an "inserted:<id>" media part names, else undefined.
export function insertedMediaId(part: string | undefined): number | undefined {
	if (part?.startsWith(INSERTED_MEDIA) !== true) return undefined

	const id = Number(part.slice(INSERTED_MEDIA.length))

	return Number.isSafeInteger(id) && id > 0 ? id : undefined
}

// What a save streams for an inserted medium: its bytes read again (never held), with the size and CRC-32 they had
// at insert; the stream fails when they no longer do.
export interface InsertedMediaContent {
	readonly bytes: ByteChunks
	readonly size: number
	readonly crc32: number
	readonly contentType: string
	// The file name it came with (the part takes its extension).
	readonly name: string
}

interface MediaRegistry {
	readonly contents: Map<number, InsertedMediaContent>
	// Media a committed save wrote: registry id → the part's model name (see commitInsertedMedia).
	readonly written: Map<number, string>
}

const registries = new WeakMap<Deck, MediaRegistry>()

// The worker registers each medium it read for an insert (dom/presentation/media.ts).
export function registerInsertedMedia(deck: Deck, id: number, content: InsertedMediaContent): void {
	let registry = registries.get(deck)

	if (registry === undefined) {
		registry = { contents: new Map(), written: new Map() }
		registries.set(deck, registry)
	}

	registry.contents.set(id, content)
}

export function insertedMediaContent(deck: Deck, id: number): InsertedMediaContent | undefined {
	return registries.get(deck)?.contents.get(id)
}

// The part a committed save wrote inserted medium `id` to (its model name), else undefined. A shape that still names
// "inserted:<id>" plays and is saved as that part.
export function insertedMediaWritten(deck: Deck, id: number): string | undefined {
	return registries.get(deck)?.written.get(id)
}

// The inserted media a save wrote: registry id → the name of the entry it added with the registry's own content.
export function insertedMediaAdded(deck: Deck, added: ReadonlyMap<object, string>): Map<number, string> {
	const out = new Map<number, string>()

	for (const [id, content] of registries.get(deck)?.contents ?? []) {
		const name = added.get(content.bytes)

		if (name !== undefined) out.set(id, name)
	}

	return out
}

// After a save committed: each medium it wrote becomes an alias of its part, and its content is `reread(id, part)`
// (the part's bytes in the saved package, for a writer that cannot relate it: a conversion), or dropped.
export function commitInsertedMedia(
	deck: Deck,
	written: ReadonlyMap<number, string>,
	reread: (id: number, part: string, prior: InsertedMediaContent) => InsertedMediaContent | undefined
): void {
	const registry = registries.get(deck)

	if (registry === undefined) return

	for (const [id, part] of written) {
		const prior = registry.contents.get(id)

		if (prior === undefined) continue

		registry.written.set(id, part)

		const next = reread(id, part, prior)

		if (next === undefined) registry.contents.delete(id)
		else registry.contents.set(id, next)
	}
}

const POSTER_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg"])

function checkPoster(poster: InsertedImage | undefined): InsertedImage | Refused {
	if (poster === undefined) return refused("malformed", "a medium needs a poster")
	if (!POSTER_TYPES.has(poster.contentType)) return refused("unsupported", `a poster of type ${poster.contentType}`)
	if (poster.bytes.length === 0 || !(poster.width > 0) || !(poster.height > 0)) return refused("malformed", "an empty poster")

	return poster
}

interface Found {
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly media: MediaRef
}

function mediaShape(deck: Deck, target: { readonly slide: SlideNode["ref"]; readonly id: number }): Found | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)

	const media = shape.media ?? (shape.frame?.kind === "media" ? shape.frame.media : undefined)

	if (media === undefined) return refused("unsupported", `shape ${String(target.id)} plays no medium`)
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	return { node, shape, media }
}

function insert(deck: Deck, op: OpOf<"media"> & { kind: "insert" }, context: ApplyContext): ApplyResult<typeof op> {
	const poster = checkPoster(op.media.poster)

	if (isRefused(poster)) return poster
	if ((op.shape.kind !== "pic" && op.shape.kind !== "frame") || op.shape.xfrm === undefined)
		return refused("malformed", "a medium needs a picture or frame shape with a box")
	if (insertedMediaContent(deck, op.media.id) === undefined) return refused("notFound", `medium ${String(op.media.id)} is not registered`)

	// A redo applies the op as applied: its poster names the image registry id again.
	const prior = op.shape.media?.poster ?? (op.shape.frame?.kind === "media" ? op.shape.frame.media.poster : undefined)
	const image = registerInsertedImage(deck, poster, pictureFillOf(op.shape)?.inserted ?? insertedMediaId(prior))
	const media: MediaRef = {
		kind: op.media.kind,
		part: `${INSERTED_MEDIA}${String(op.media.id)}`,
		contentType: op.media.contentType,
		size: op.media.size
	}
	// A click plays it (a:hlinkClick ppaction://media, as PowerPoint inserts media). In an ODP deck it is the frame a
	// draw:plugin reads back as, its poster the frame's preview; in pptx a picture whose fill is the poster.
	const { frame: _frame, props: _props, ...base } = op.shape
	const shape: ShapeNode =
		deck.format === "odp"
			? {
					...base,
					kind: "frame",
					media: { ...media, poster: `${INSERTED_MEDIA}${String(image)}` },
					frame: { kind: "media", media: { ...media, poster: `${INSERTED_MEDIA}${String(image)}` } }
				}
			: {
					...base,
					media,
					actions: { ...op.shape.actions, click: { kind: "media" } },
					props: { ...op.shape.props, fill: { kind: "picture", inserted: image, stretch: { l: 0, t: 0, r: 0, b: 0 } } }
				}
	const result = applyShape.apply(
		deck,
		{ family: "shape", kind: "insert", slide: op.slide, shape, ...(op.index === undefined ? {} : { index: op.index }) },
		context
	)

	if (result.kind === "refused") return result

	const id = result.op.family === "shape" && result.op.kind === "insert" ? result.op.shape.id : shape.id

	return { kind: "applied", inverse: result.inverse, op: { ...op, shape: { ...shape, id } } }
}

function setPoster(deck: Deck, op: OpOf<"media"> & { kind: "setPoster" }): ApplyResult<typeof op> {
	const poster = checkPoster(op.poster)

	if (isRefused(poster)) return poster

	const found = mediaShape(deck, op.target)

	if (isRefused(found)) return found
	if (found.shape.kind !== "pic") return refused("unsupported", "the poster of a medium in a frame")

	const prior = pictureFillOf(found.shape)
	const back = {
		family: "shape",
		kind: "setProps",
		target: op.target,
		props: { fill: prior === undefined ? undefined : cloneModel(prior) }
	} as const
	const { part: _part, inserted, ...rest } = prior ?? { kind: "picture" as const }
	const id = registerInsertedImage(
		deck,
		poster,
		inserted !== undefined && insertedImage(deck, inserted) === poster ? inserted : undefined
	)

	found.shape.props = { ...found.shape.props, fill: { ...rest, kind: "picture", inserted: id } }
	found.node.revision++

	return { kind: "applied", inverse: { ops: [back], bytes: 0 }, op }
}

const VOLUME_MAX = 100_000

function isMediaNode(node: TimeNode, shape: number): boolean {
	return (
		node.kind === "behavior" &&
		(node.behavior.type === "audio" || node.behavior.type === "video") &&
		node.behavior.target.kind === "shape" &&
		node.behavior.target.shape === shape
	)
}

function maxId(node: TimeNode): number {
	let max = node.ctn.id

	for (const child of node.ctn.children) max = Math.max(max, maxId(child))

	return max
}

type MediaBehavior = Extract<Extract<TimeNode, { kind: "behavior" }>["behavior"], { type: "audio" | "video" }>

// The playback options a slide's timing gives the medium of shape `id` (its media node under the root), what the
// Video and Audio tabs show; absent options are PresentationML's defaults (full volume, sound on, shown when
// stopped, not full screen, no loop).
export function mediaPlayback(timing: TimingTree | undefined, id: number): MediaPlayback {
	const node = timing?.root.ctn.children.find(child => isMediaNode(child, id))

	if (node?.kind !== "behavior") return {}

	const behavior = node.behavior as MediaBehavior

	return {
		...(behavior.vol === undefined ? {} : { volume: behavior.vol }),
		...(behavior.mute === undefined ? {} : { mute: behavior.mute }),
		...(behavior.showWhenStopped === undefined ? {} : { hideWhenStopped: !behavior.showWhenStopped }),
		...(behavior.fullScrn === undefined ? {} : { fullScreen: behavior.fullScrn }),
		...(node.ctn.repeatCount === "indefinite" ? { loop: true } : {})
	}
}

// The slide's tree with the shape's media node set to `playback`, made (as PowerPoint writes one for every medium)
// when the tree has none: a child of the root par, hold-filled, started by an event.
function withPlayback(timing: TimingTree | undefined, found: Found, playback: MediaPlayback): TimingTree {
	const tree: TimingTree =
		timing === undefined
			? {
					root: {
						kind: "par",
						ctn: { id: 1, nodeType: "tmRoot", dur: "indefinite", restart: "never", stCondLst: [], endCondLst: [], children: [] }
					},
					builds: []
				}
			: cloneModel(timing)
	const shape = found.shape.id
	const children = tree.root.ctn.children
	const at = children.findIndex(child => isMediaNode(child, shape))
	const node: Extract<TimeNode, { kind: "behavior" }> =
		at >= 0
			? (children[at] as Extract<TimeNode, { kind: "behavior" }>)
			: {
					kind: "behavior",
					behavior: { type: found.media.kind, target: { kind: "shape", shape } },
					ctn: { id: maxId(tree.root) + 1, fill: "hold", stCondLst: [{ delay: "indefinite" }], endCondLst: [], children: [] }
				}
	const prior = node.behavior as MediaBehavior
	const behavior: MediaBehavior = {
		...prior,
		...(playback.volume === undefined ? {} : { vol: playback.volume }),
		...(playback.mute === undefined ? {} : { mute: playback.mute }),
		...(playback.hideWhenStopped === undefined ? {} : { showWhenStopped: !playback.hideWhenStopped }),
		...(playback.fullScreen === undefined || prior.type !== "video" ? {} : { fullScrn: playback.fullScreen })
	}
	const ctn = { ...node.ctn }

	if (playback.loop === true) ctn.repeatCount = "indefinite"
	else if (playback.loop === false) delete ctn.repeatCount

	const next: TimeNode = { kind: "behavior", behavior, ctn }

	if (at >= 0) children[at] = next
	else children.push(next)

	return tree
}

function setPlayback(deck: Deck, op: OpOf<"media"> & { kind: "setPlayback" }, context: ApplyContext): ApplyResult<typeof op> {
	const volume = op.playback.volume

	if (volume !== undefined && !(Number.isInteger(volume) && volume >= 0 && volume <= VOLUME_MAX))
		return refused("malformed", "a volume out of range")
	// Neither has an element of the medium's own in PresentationML: autoplay is a mediacall effect of the main
	// sequence (set from the Animations tab), and ECMA-376 writes no rewind.
	if (op.playback.autoPlay !== undefined) return refused("unsupported", "autoplay is an effect of the main sequence")
	if (op.playback.rewind !== undefined) return refused("unsupported", "rewind after playing")

	const found = mediaShape(deck, op.target)

	if (isRefused(found)) return found
	// ODF keeps a medium's playback in its draw:plugin's parameters, which a save writes for the media an op inserted
	// (core/odp/write/emit/media.ts); a plugin the file has is spliced as its source.
	if (deck.format === "odp" && found.shape.src !== undefined)
		return refused("notImplemented", "the playback of a medium the ODP file holds")

	const result = applyTiming.apply(
		deck,
		{ family: "timing", kind: "setTiming", slide: op.target.slide, timing: withPlayback(found.node.timing, found, op.playback) },
		context
	)

	return result.kind === "refused" ? result : { kind: "applied", inverse: result.inverse, op }
}

export const applyMedia: ApplyFamily<MediaOp> = {
	apply: (deck, op, context) => {
		switch (op.kind) {
			case "insert":
				return insert(deck, op, context)
			case "setPoster":
				return setPoster(deck, op)
			case "setPlayback":
				return setPlayback(deck, op, context)
		}
	},
	touches: (op): readonly Touch[] => {
		switch (op.kind) {
			case "insert":
				return [{ kind: "shape", slide: op.slide, shape: op.shape.id, dirt: { kind: "node" } }]
			case "setPoster":
				return [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }]
			case "setPlayback":
				// An inserted ODP medium is written again with its page, whose timing this is.
				return [{ kind: "slide", slide: op.target.slide, dirt: { kind: "slidePart", part: "timing" } }]
		}
	}
}
