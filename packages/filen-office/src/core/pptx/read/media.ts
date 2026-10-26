import type { MediaRef } from "../../presentation/model"
import { relPart, type ReadContext } from "./drawing"
import { G } from "./xml"

// Audio and video of a picture shape (p:nvPr, ECMA-376 Part 1 §20.1.3 a:videoFile / a:audioFile / a:wavAudioFile
// / a:quickTimeFile, and PowerPoint 2010's p14:media in the nvPr extension list). An embedded part is served by
// range or stream (core/opc/mediaPolicy.ts); a linked target is never fetched, only shown with its poster and
// opened after a click when it is a web address.

const P14_MEDIA_EXT = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"

export interface MediaFacts {
	contentType(part: string): string | undefined
	size(part: string): number | undefined
}

function target(context: ReadContext, id: string | undefined): { readonly part?: string; readonly external?: string } {
	if (id === undefined) return {}

	const relationship = context.relationships.byId(id)

	if (relationship === undefined) return {}
	if (relationship.external) return { external: relationship.target }

	const part = relPart(context, id)

	return part === undefined ? {} : { part }
}

const AUDIO_LOCALS: ReadonlySet<string> = new Set(["audioFile", "wavAudioFile"])
const VIDEO_LOCALS: ReadonlySet<string> = new Set(["videoFile", "quickTimeFile"])

export function readMedia(context: ReadContext, nvPr: number, facts: MediaFacts, poster?: string): MediaRef | undefined {
	const r = context.reader
	let kind: MediaRef["kind"] | undefined
	let place: { readonly part?: string; readonly external?: string } = {}

	for (let child = r.first(nvPr); child >= 0; child = r.next(child)) {
		if (r.group(child) !== G.A) continue

		const local = r.local(child)

		if (AUDIO_LOCALS.has(local) || VIDEO_LOCALS.has(local)) {
			kind = AUDIO_LOCALS.has(local) ? "audio" : "video"
			place = target(context, local === "wavAudioFile" ? r.rel(child, "embed") : r.rel(child, "link"))

			break
		}
	}

	if (kind === undefined) return undefined

	// p14:media: the embedded copy PowerPoint 2010+ plays (r:embed) and its link (r:link).
	for (const ext of r.children(r.child(nvPr, G.P, "extLst"), G.P, "ext")) {
		if (r.attr(ext, "uri") !== P14_MEDIA_EXT) continue

		const media = r.child(ext, G.P14, "media")
		const embedded = target(context, r.rel(media, "embed"))
		const linked = target(context, r.rel(media, "link"))

		if (embedded.part !== undefined) place = { part: embedded.part }
		else if (linked.external !== undefined && place.part === undefined) place = { external: linked.external }
	}

	const contentType =
		(place.part === undefined ? undefined : facts.contentType(place.part)) ?? (kind === "audio" ? "audio/unknown" : "video/unknown")
	const size = place.part === undefined ? undefined : facts.size(place.part)

	return {
		kind,
		...place,
		contentType,
		...(size === undefined ? {} : { size }),
		...(poster === undefined ? {} : { poster })
	}
}
