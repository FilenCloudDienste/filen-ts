import type { ExportContainer, VideoSaveTarget } from "@/features/preview/videoEdit/types"

// Where an edited video can be saved. The export always writes a fragmented ISO BMFF file (streamed into the upload,
// never staged): MP4, or QuickTime for a .mov (mediabunny's MOV writer fragments the same way). A file whose name
// says another container (Matroska, WebM, MPEG-TS) is never rewritten under that name: it gets an MP4 copy beside it.

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".")

	return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

// The container an in-place save writes, from the name alone (sync: a rename's re-check must agree with the slot's
// pin without a probe). Null: the edit can only become a copy.
export function inPlaceVideoContainerByName(name: string): ExportContainer | null {
	switch (extensionOf(name)) {
		case "mp4":
		case "m4v": {
			return "mp4"
		}

		case "mov":
		case "qt": {
			return "mov"
		}

		default: {
			return null
		}
	}
}

// The probe's container names (and mediabunny's) that are ISO BMFF, which an in-place save may rewrite: a file named
// .mp4 that is really Matroska is saved as a copy, never as a version that changes what the name's bytes are.
const ISOBMFF_CONTAINERS: ReadonlySet<string> = new Set(["mp4", "mov", "m4v", "isobmff", "quicktime", "qtff"])

export function isIsobmffContainer(container: string): boolean {
	return ISOBMFF_CONTAINERS.has(container.toLowerCase())
}

export interface VideoTargets {
	container: ExportContainer
	// In the order the Save popover offers them: the first is the primary action.
	targets: readonly VideoSaveTarget[]
	// The extension a copy is named with ("clip (edited).mp4").
	copyExtension: string
}

// `versioning`: the account keeps old versions (undefined when not known yet: treated as on). Without it an in-place
// save destroys the original, so the copy comes first.
export function videoSaveTargets(params: { name: string; container: string; versioning?: boolean | undefined }): VideoTargets {
	const inPlace = isIsobmffContainer(params.container) ? inPlaceVideoContainerByName(params.name) : null

	if (inPlace === null) {
		return { container: "mp4", targets: ["copy"], copyExtension: "mp4" }
	}

	const extension = extensionOf(params.name)

	return {
		container: inPlace,
		targets: params.versioning === false ? ["copy", "inPlace"] : ["inPlace", "copy"],
		copyExtension: extension === "" ? inPlace : extension
	}
}

// The MIME type an upload of the export is typed with (the SDK would otherwise guess from the name).
export function containerMime(container: ExportContainer): string {
	return container === "mov" ? "video/quicktime" : "video/mp4"
}
