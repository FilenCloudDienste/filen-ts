import type { ExportDrop, ExportPlan, HdrHandling, VideoSaveOutcome, VideoSaveRefusal } from "@/features/preview/videoEdit/types"
import type { NamespaceKey } from "@/lib/i18n"

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

// Why a save cannot run for this recipe here (plan.blockers): only its sound (muting it would let the save run), or its
// picture. Null when nothing blocks it.
export type SaveBlock = "audio" | "video"

export function saveBlock(plan: ExportPlan | null): SaveBlock | null {
	if (plan === null || plan.blockers.length === 0) {
		return null
	}

	return plan.mutingUnblocks ? "audio" : "video"
}

export type DropNotice = "subtitlesAndChapters" | "subtitles" | "chapters" | "extraAudio" | "hdrMetadata" | "location"

// The Save popover's lines for what a save leaves out, subtitles and chapters as one line when both go. HDR details
// going with a conversion to SDR are that conversion's own notice, not a second line.
export function dropNotices(dropped: readonly ExportDrop[], hdr: HdrHandling | null): DropNotice[] {
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

	if (set.has("hdrMetadata") && hdr !== "toSdr") {
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

// How the editor words a refused save.
export const REFUSAL_LABELS: Readonly<Record<VideoSaveRefusal, NamespaceKey<"preview">>> = {
	offline: "previewVideoSaveRefusedOffline",
	quota: "previewVideoSaveRefusedQuota",
	unavailable: "previewVideoSaveRefusedUnavailable",
	gop: "previewVideoSaveRefusedGop",
	noVideo: "previewVideoSaveRefusedNoVideo",
	codec: "previewVideoSaveRefusedCodec",
	target: "previewVideoSaveRefusedTarget",
	busy: "previewVideoSaveRefusedBusy"
}

// A refusal worth trying again once its cause is gone (back online, storage freed, the other save of the file done);
// the others stay as they are.
export function refusalRetries(reason: VideoSaveRefusal): boolean {
	return reason === "offline" || reason === "quota" || reason === "busy"
}

export type SaveErrorCode = Extract<VideoSaveOutcome, { status: "error" }>["code"]

// How the editor words why a save failed (never the error's own text, which is not for users).
export const SAVE_ERROR_LABELS: Readonly<Record<SaveErrorCode, NamespaceKey<"preview">>> = {
	stalled: "previewVideoSaveFailedStalled",
	workerLost: "previewVideoSaveFailedWorkerLost",
	uploadFailed: "previewVideoSaveFailedUploadFailed",
	unknown: "previewVideoSaveFailed"
}

// A save the user could start from the keyboard without looking at the Save popover first: nothing in it to read
// (no HDR conversion, nothing dropped, nothing blocking).
export function savesSilently(plan: ExportPlan): boolean {
	return plan.hdr !== "toSdr" && plan.dropped.length === 0 && plan.blockers.length === 0
}

// What a save would do for the recipe on screen: still being worked out, worked out, or failed to be.
export type PlanState = { status: "planning" } | { status: "ready"; plan: ExportPlan } | { status: "failed" }

// Progress announced to assistive technology in steps this many percent apart, not every percent shown.
const ANNOUNCE_STEP = 20

export function announcedPercent(percent: number): number {
	return Math.floor(Math.min(100, Math.max(0, percent)) / ANNOUNCE_STEP) * ANNOUNCE_STEP
}
