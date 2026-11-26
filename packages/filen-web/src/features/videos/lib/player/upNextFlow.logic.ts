import {
	needsStillWatchingPrompt,
	shouldShowUpNext,
	stillWatchingStep,
	upNextLeadSeconds,
	upNextShowAt,
	type StillWatchingEvent
} from "@filen/shared/videos"

// When the Up Next card shows, when it plays the next item by itself, and when the player asks whether
// anyone is still watching instead. The countdown runs on playback time, so a pause holds it.

export interface UpNextTiming {
	// Playback position where the card appears.
	showAt: number
	// Position where the next item starts by itself (the end of the file at the latest).
	autoplayAt: number
}

// Null for items too short for Up Next (under 10 minutes).
export function upNextTiming(duration: number, creditsStart: number | null): UpNextTiming | null {
	const showAt = upNextShowAt(duration, creditsStart)

	if (showAt === null) {
		return null
	}

	return { showAt, autoplayAt: Math.min(duration, showAt + upNextLeadSeconds(duration)) }
}

// Up Next for the item playing: only an episode with a next one, and on a stack only during its last part; never on
// repeat, where the item plays again instead.
export function upNextTimingFor(params: {
	repeat: boolean
	hasNext: boolean
	isEpisode: boolean
	part: number
	parts: number
	duration: number
	creditsStart: number | null
}): UpNextTiming | null {
	if (params.repeat || !params.hasNext || !params.isEpisode || params.part < params.parts - 1) {
		return null
	}

	return upNextTiming(params.duration, params.creditsStart)
}

export interface UpNextState {
	visible: boolean
	// Seconds until the next item starts, rounded up; 0 when it is due.
	countdown: number
}

export function upNextState(params: {
	timing: UpNextTiming | null
	position: number
	duration: number
	creditsStart: number | null
	// "Watch credits": the card stays away for this item.
	dismissed: boolean
	// The card showed before: it stays until the end (or a seek back before showAt), even within the last
	// 20 seconds, where it never starts showing.
	shown: boolean
}): UpNextState {
	const { timing, position, duration, creditsStart, dismissed, shown } = params

	if (timing === null || dismissed) {
		return { visible: false, countdown: 0 }
	}

	const visible = shown ? position >= timing.showAt : shouldShowUpNext(position, duration, creditsStart)

	return { visible, countdown: visible ? Math.max(0, Math.ceil(timing.autoplayAt - position)) : 0 }
}

// What follows when the whole item ended: on repeat the item again; with nothing next, post-play; in native
// fullscreen (no page shown) the next item at once; after "Watch credits" or over a card, post-play offering the
// next; else the next by itself (or still watching).
export type ItemEndAction = "replay" | "postPlay" | "playNext" | "offerNext" | "autoAdvance"

export function itemEndAction(params: {
	repeat: boolean
	hasNext: boolean
	nativeFullscreen: boolean
	upNextDismissed: boolean
	cardShown: boolean
}): ItemEndAction {
	if (params.repeat) {
		return "replay"
	}

	if (!params.hasNext) {
		return "postPlay"
	}

	if (params.nativeFullscreen) {
		return "playNext"
	}

	return params.upNextDismissed || params.cardShown ? "offerNext" : "autoAdvance"
}

// What happens when the next item is due by itself (the countdown ran out, or the file ended).
export type AutoAdvance = "play" | "askStillWatching" | "none"

export function autoAdvance(params: { hasNext: boolean; autoplay: boolean; consecutiveAutoplays: number }): AutoAdvance {
	if (!params.hasNext || !params.autoplay) {
		return "none"
	}

	return needsStillWatchingPrompt(params.consecutiveAutoplays) ? "askStillWatching" : "play"
}

// Consecutive items started by autoplay with no control touched in between, for the whole player session.
export class StillWatchingCounter {
	private count = 0

	public get value(): number {
		return this.count
	}

	public note(event: StillWatchingEvent): void {
		this.count = stillWatchingStep(this.count, event)
	}
}
