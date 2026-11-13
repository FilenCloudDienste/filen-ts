import type { ExportDrop, ExportPlan, VideoSourceInfo } from "@/features/preview/videoEdit/types"

// Which editing controls this browser can offer, read from the plan. `ExportPlan.unavailable` names features by these
// ids (anything else in it is not a control and is ignored here): a feature listed there is disabled with the reason
// beside it, never hidden, and never silently dropped from a save.
export const EDIT_FEATURES = [
	"crop",
	"rotate",
	"flip",
	"resize",
	"quality",
	"adjust",
	"text",
	"speed",
	"gain",
	"audioTracks",
	"precise"
] as const

export type EditFeature = (typeof EDIT_FEATURES)[number]

const FEATURES: ReadonlySet<string> = new Set(EDIT_FEATURES)

function isFeature(value: string): value is EditFeature {
	return FEATURES.has(value)
}

export function unavailableFeatures(plan: ExportPlan | null): ReadonlySet<EditFeature> {
	return new Set(plan === null ? [] : plan.unavailable.filter(isFeature))
}

// Colour adjustments on an HDR source need the 10-bit path; otherwise they would be graded in the wrong space.
export function colourBlockedByHdr(info: VideoSourceInfo, plan: ExportPlan | null): boolean {
	return info.transfer !== "sdr" && plan?.hdr !== "hevc10"
}

export type DropNotice = "subtitlesAndChapters" | "subtitles" | "chapters" | "extraAudio" | "hdrMetadata" | "location"

// The Save popover's lines for what a save leaves out, subtitles and chapters as one line when both go.
export function dropNotices(dropped: readonly ExportDrop[]): DropNotice[] {
	const set = new Set(dropped)
	const notices: DropNotice[] = []

	if (set.has("subtitles") && set.has("chapters")) {
		notices.push("subtitlesAndChapters")
	} else if (set.has("subtitles")) {
		notices.push("subtitles")
	} else if (set.has("chapters")) {
		notices.push("chapters")
	}

	if (set.has("extraAudio")) {
		notices.push("extraAudio")
	}

	if (set.has("hdrMetadata")) {
		notices.push("hdrMetadata")
	}

	if (set.has("location")) {
		notices.push("location")
	}

	return notices
}

export type TargetNote = "versionKept" | "versioningOff" | "copyOnly"

// What saving in place does to the original. The plan lists the copy first while still offering in place exactly when
// the drive keeps no versions (a save in place would replace the original for good); a source it cannot write in place
// offers the copy alone.
export function targetNote(plan: ExportPlan): TargetNote {
	if (!plan.targets.includes("inPlace")) {
		return "copyOnly"
	}

	return plan.targets[0] === "copy" ? "versioningOff" : "versionKept"
}

// Whole minutes an export is expected to take, at least one; 0 under a minute.
export function etaMinutes(seconds: number | null): number {
	if (seconds === null || !Number.isFinite(seconds) || seconds < 60) {
		return 0
	}

	return Math.max(1, Math.round(seconds / 60))
}
