import { codecStringAlternatives } from "@filen/shared/videos"
import type { AudioMode } from "@/lib/media/remuxTypes"

// The decisions behind the remux player's MediaSource buffering, as pure functions of plain numbers.

export type TimeRange = readonly [start: number, end: number]

export type BrowserEngine = "chromium" | "firefox" | "webkit"

const MiB = 1_048_576

export interface BufferLimits {
	// Bytes a SourceBuffer of each kind holds before the browser refuses appends or evicts on its own.
	video: number
	audio: number
}

export function browserEngine(userAgent: string): BrowserEngine {
	if (userAgent.includes("Firefox/")) {
		return "firefox"
	}

	if (/Chrome\/|Chromium\/|Edg\//.test(userAgent)) {
		return "chromium"
	}

	return "webkit"
}

// Chromium sizes its demuxer limits by device class (desktop, then Android by memory); Firefox has one
// pair. WebKit's limits are larger than Firefox's; its smaller pair is used as a safe floor.
export function bufferLimits(params: { engine: BrowserEngine; mobile: boolean; deviceMemoryGiB: number | null }): BufferLimits {
	const { engine, mobile, deviceMemoryGiB } = params

	if (engine !== "chromium") {
		return { video: 150 * MiB, audio: 20 * MiB }
	}

	if (!mobile) {
		return { video: 150 * MiB, audio: 12 * MiB }
	}

	const memory = deviceMemoryGiB ?? 2

	if (memory >= 4) {
		return { video: 80 * MiB, audio: 5 * MiB }
	}

	if (memory >= 2) {
		return { video: 30 * MiB, audio: 2 * MiB }
	}

	return { video: 15 * MiB, audio: MiB }
}

export const MIN_AHEAD_SECONDS = 10
export const MAX_AHEAD_SECONDS = 60
// Share of a SourceBuffer's limit the forward window may fill, leaving room for the back buffer.
const AHEAD_LIMIT_SHARE = 0.6
// Fetching resumes once the forward buffer has drained below this share of the window.
export const RESUME_SHARE = 0.5

// Seconds to keep buffered ahead of the playhead for a stream of `bitrate` bits per second. `scale`
// shrinks the window after the browser ran out of room anyway.
export function aheadSeconds(params: { limitBytes: number; bitrate: number; scale: number }): number {
	const { limitBytes, bitrate, scale } = params
	const fits = bitrate > 0 ? (AHEAD_LIMIT_SHARE * limitBytes * 8) / bitrate : MAX_AHEAD_SECONDS

	return Math.min(MAX_AHEAD_SECONDS, Math.max(MIN_AHEAD_SECONDS, Math.min(MAX_AHEAD_SECONDS, fits) * scale))
}

// Whether the forward buffer has drained enough to fetch more.
export function needsMore(params: { bufferedAhead: number; ahead: number }): boolean {
	return params.bufferedAhead < params.ahead * RESUME_SHARE
}

// The contiguous buffered seconds from `time` on, allowing gaps up to `tolerance`.
export function bufferedAhead(ranges: readonly TimeRange[], time: number, tolerance: number = MAX_BUFFER_HOLE): number {
	let end = time

	for (const [start, rangeEnd] of ranges) {
		if (start <= end + tolerance && rangeEnd > end) {
			end = rangeEnd
		}
	}

	return end - time
}

export function intersectRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
	const out: TimeRange[] = []
	let i = 0
	let j = 0

	while (i < a.length && j < b.length) {
		const left = a[i]
		const right = b[j]

		if (left === undefined || right === undefined) {
			break
		}

		const start = Math.max(left[0], right[0])
		const end = Math.min(left[1], right[1])

		if (start < end) {
			out.push([start, end])
		}

		if (left[1] < right[1]) {
			i++
		} else {
			j++
		}
	}

	return out
}

export const BACK_BUFFER_SECONDS = 10
export const BACK_BUFFER_INTERVAL_MS = 30_000
// Fill share of a SourceBuffer's limit past which the back buffer goes regardless of the interval.
export const EVICT_FILL_SHARE = 0.7

// Removals closer together than this are never worth it, however full the buffer.
export const MIN_EVICTION_GAP_MS = 5_000
// Less than this behind the back-buffer edge is left for the next removal.
const MIN_REMOVAL_SECONDS = 1

// The range behind the playhead to remove now, or null. Removal is batched (at most every interval)
// because each remove() is a round trip through the media pipeline; a filling buffer brings it forward,
// but never to more than one removal per MIN_EVICTION_GAP_MS.
export function backBufferEviction(params: {
	currentTime: number
	bufferedStart: number
	now: number
	lastEvictionAt: number
	fillShare: number
}): TimeRange | null {
	const end = params.currentTime - BACK_BUFFER_SECONDS

	if (end - params.bufferedStart < MIN_REMOVAL_SECONDS) {
		return null
	}

	const since = params.now - params.lastEvictionAt
	const due = since >= BACK_BUFFER_INTERVAL_MS || (params.fillShare > EVICT_FILL_SHARE && since >= MIN_EVICTION_GAP_MS)

	return due ? [params.bufferedStart, end] : null
}

// A track's bitrate from what has been appended to it, once there is enough to tell; `fallback` before.
export function trackBitrate(params: { bytes: number; seconds: number; fallback: number }): number {
	return params.seconds >= MIN_REMOVAL_SECONDS ? (params.bytes * 8) / params.seconds : params.fallback
}

// Bytes a SourceBuffer holds, estimated from its buffered seconds and the stream's bitrate.
export function estimatedBytes(ranges: readonly TimeRange[], bitrate: number): number {
	let seconds = 0

	for (const [start, end] of ranges) {
		seconds += end - start
	}

	return (seconds * bitrate) / 8
}

// Seconds behind the playhead kept when the browser is out of room.
export const QUOTA_KEEP_BEHIND_SECONDS = 2
export const QUOTA_SHRINK = 0.7

export type QuotaAction =
	// Remove [start, end) and retry the same append.
	| { type: "evict"; range: TimeRange }
	// Retry once playback has consumed some of the buffer, with a smaller forward window.
	| { type: "shrink"; scale: number }
	// The segment alone does not fit: nothing to make room with.
	| { type: "fatal" }

// What to do after an append failed with QuotaExceededError.
export function quotaAction(params: { attempt: number; currentTime: number; ranges: readonly TimeRange[]; scale: number }): QuotaAction {
	const { attempt, currentTime, ranges, scale } = params
	const first = ranges[0]

	if (first === undefined) {
		return { type: "fatal" }
	}

	const evictEnd = currentTime - QUOTA_KEEP_BEHIND_SECONDS

	if (attempt === 0 && evictEnd > first[0]) {
		return { type: "evict", range: [first[0], evictEnd] }
	}

	// Behind the playhead is already gone and nothing ahead of it will drain: the segment is bigger than
	// the buffer could ever hold.
	if (bufferedAhead(ranges, currentTime) <= 0) {
		return { type: "fatal" }
	}

	return { type: "shrink", scale: scale * QUOTA_SHRINK }
}

// Where the element is put for a start at `time`: there, unless the start's first picture comes later, which only
// happens before a file's first key picture (a stream starting at 1.4 s, a loop back to 0), or where a file without an
// index could not be seeked that far (`clamped`). Audio alone starts where its first sound does.
export function startTarget(
	time: number,
	start: { video: { keyTime: number; clamped: boolean } | null; audio: { startTime: number } | null }
): number {
	if (start.video !== null) {
		return start.video.clamped || start.video.keyTime > time ? start.video.keyTime : time
	}

	return start.audio !== null && start.audio.startTime > time ? start.audio.startTime : time
}

// Buffered seconds both tracks need past a seek target for it to play from what is already there.
export const SEEK_IN_BUFFER_SECONDS = 0.5

export type SeekPlan = "inBuffer" | "restart"

// A null track is one the session does not play.
export function seekPlan(params: { time: number; video: readonly TimeRange[] | null; audio: readonly TimeRange[] | null }): SeekPlan {
	const covered = (ranges: readonly TimeRange[] | null) =>
		ranges === null || bufferedAhead(ranges, params.time, 0) >= SEEK_IN_BUFFER_SECONDS

	return covered(params.video) && covered(params.audio) ? "inBuffer" : "restart"
}

// Where playback can go on: buffered on every track the session plays (a null one it does not).
export function playableRanges(video: readonly TimeRange[] | null, audio: readonly TimeRange[] | null): TimeRange[] {
	if (video === null) {
		return audio === null ? [] : [...audio]
	}

	return audio === null ? [...video] : intersectRanges(video, audio)
}

// The forward buffer playback can count on: the shortest over the tracks the session plays.
export function forwardBuffered(time: number, video: readonly TimeRange[] | null, audio: readonly TimeRange[] | null): number {
	const tracks = [video, audio].filter(ranges => ranges !== null)

	return tracks.length === 0 ? 0 : Math.min(...tracks.map(ranges => bufferedAhead(ranges, time)))
}

// A session plays audio alone on an element that cannot show video, or for a file that has none. A file
// whose video track cannot be remuxed still fails on a <video> element rather than playing as sound.
export function isAudioOnlySession(params: { elementShowsVideo: boolean; hasVideoTrack: boolean }): boolean {
	return !params.elementShowsVideo || !params.hasVideoTrack
}

// The forward window: sized by the video SourceBuffer's limit and the file's bitrate, or for audio alone by
// the audio SourceBuffer's limit and the audio track's bitrate.
export function sessionAhead(params: {
	audioOnly: boolean
	limits: BufferLimits
	fileBitrate: number
	audioBitrate: number
	scale: number
}): number {
	const { audioOnly, limits, scale } = params

	return audioOnly
		? aheadSeconds({ limitBytes: limits.audio, bitrate: params.audioBitrate, scale })
		: aheadSeconds({ limitBytes: limits.video, bitrate: params.fileBitrate, scale })
}

// The audio track a session starts with. `mode` null: copy or re-encode, whichever the page takes. Audio
// alone ignores a choice of no audio: there would be nothing to play.
export function initialAudio(params: {
	tracks: readonly { id: number; isDefault: boolean }[]
	chosen: { trackId: number; mode: AudioMode } | undefined
	audioOnly: boolean
}): { trackId: number; mode: AudioMode | null } | null {
	const { tracks, chosen, audioOnly } = params
	const chosenTrack = chosen === undefined || chosen.mode === "none" ? undefined : tracks.find(track => track.id === chosen.trackId)
	const defaultTrack = tracks.find(track => track.isDefault) ?? tracks[0]

	if (chosen?.mode === "none" && !audioOnly) {
		return null
	}

	if (chosen !== undefined && chosenTrack !== undefined) {
		return { trackId: chosenTrack.id, mode: chosen.mode }
	}

	return defaultTrack === undefined ? null : { trackId: defaultTrack.id, mode: null }
}

export function audioMp4Mime(codec: string): string {
	return `audio/mp4; codecs="${codec}"`
}

// The first spelling of a copied track's codec string the MediaSource takes, or null for none: engines
// spell some codecs differently (MP3 in MP4 is mp4a.6B or mp4a.69 to Chrome, mp3 to Firefox).
export function supportedCopyCodec(codec: string, isTypeSupported: (mime: string) => boolean): string | null {
	return codecStringAlternatives(codec).find(spelling => isTypeSupported(audioMp4Mime(spelling))) ?? null
}

// Buffered ranges outside [keepStart, keepEnd), to remove when playback restarts elsewhere.
export function rangesOutside(ranges: readonly TimeRange[], keepStart: number, keepEnd: number): TimeRange[] {
	const out: TimeRange[] = []

	for (const [start, end] of ranges) {
		if (start < keepStart) {
			out.push([start, Math.min(end, keepStart)])
		}

		if (end > keepEnd) {
			out.push([Math.max(start, keepEnd), end])
		}
	}

	return out
}

// Gap handling, after hls.js's gap controller defaults.
export const MAX_BUFFER_HOLE = 0.1
export const NUDGE_OFFSET = 0.1
export const NUDGE_MAX_RETRY = 3
export const STALL_DETECTION_MS = 1250
// Lands just inside the next range rather than on its edge, which some engines still treat as a gap.
const SKIP_PAST_HOLE = 0.05

export type StallAction = { type: "none" } | { type: "skip"; to: number } | { type: "nudge"; to: number } | { type: "fatal" }

// What to do about a playhead that should be moving. `ranges` is where both tracks are buffered.
export function stallAction(params: { currentTime: number; ranges: readonly TimeRange[]; stalledMs: number; nudges: number }): StallAction {
	const { currentTime, ranges, stalledMs, nudges } = params
	const inside = ranges.find(([start, end]) => start <= currentTime && currentTime < end)

	if (inside === undefined) {
		const next = ranges.find(([start]) => start > currentTime)

		if (next === undefined) {
			return { type: "none" }
		}

		const hole = next[0] - currentTime

		// A small hole (a GOP boundary, a seek landing before the first frame) is skipped at once, a
		// larger one only once the playhead has demonstrably stopped.
		if (hole <= MAX_BUFFER_HOLE || stalledMs >= STALL_DETECTION_MS) {
			return { type: "skip", to: next[0] + SKIP_PAST_HOLE }
		}

		return { type: "none" }
	}

	if (stalledMs < STALL_DETECTION_MS || bufferedAhead(ranges, currentTime) <= MAX_BUFFER_HOLE) {
		return { type: "none" }
	}

	// Data is there and the playhead does not move: a decoder stuck on the frame at the playhead.
	if (nudges >= NUDGE_MAX_RETRY) {
		return { type: "fatal" }
	}

	return { type: "nudge", to: currentTime + NUDGE_OFFSET * (nudges + 1) }
}

// Data ahead of the playhead the browser dropped on its own (Chrome and Firefox evict future frames
// when the buffer is full): the playhead is about to run dry at a point the current fetch had already
// buffered (`seen`, every range observed after its appends). A gap in the file itself was never
// buffered and stays with the gap handling.
export function evictedAhead(params: { currentTime: number; ranges: readonly TimeRange[]; seen: readonly TimeRange[] }): boolean {
	const { currentTime, ranges, seen } = params
	const ahead = bufferedAhead(ranges, currentTime)
	const holeStart = currentTime + ahead
	const holeProbe = holeStart + 2 * MAX_BUFFER_HOLE

	return ahead < MIN_AHEAD_SECONDS && seen.some(([start, end]) => start <= holeStart && end >= holeProbe)
}

// The union of two sorted range lists, merged where they touch.
export function unionRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
	const all = [...a, ...b].sort((left, right) => left[0] - right[0])
	const out: [number, number][] = []

	for (const [start, end] of all) {
		const last = out.at(-1)

		if (last !== undefined && start <= last[1]) {
			last[1] = Math.max(last[1], end)
		} else {
			out.push([start, end])
		}
	}

	return out
}

export interface StreamTrackState {
	ended: boolean
	idle: boolean
	updating: boolean
}

// Whether endOfStream() may be called: every track that has a SourceBuffer got its last segment in, and
// none is mid-operation (endOfStream throws while one updates).
export function shouldEndStream(params: { open: boolean; tracks: readonly (StreamTrackState | null)[] }): boolean {
	return params.open && params.tracks.every(track => track === null || (track.ended && track.idle && !track.updating))
}

// Refetches after browser eviction allowed within EVICTION_WINDOW_MS before playback is given up.
export const MAX_EVICTION_REFETCHES = 2
export const EVICTION_WINDOW_MS = 60_000

// The refetch times still inside the window.
export function recentEvictions(times: readonly number[], now: number): number[] {
	return times.filter(time => now - time < EVICTION_WINDOW_MS)
}

// Runs a session's timeline operations (restarts, MediaSource rebuilds, audio switches) one at a time,
// in order. Restart requests coalesce: a queued restart takes the latest target when its turn comes, so
// a burst of seeks costs at most the restart in flight plus one.
export class TimelineOps {
	private chain: Promise<void> = Promise.resolve()
	private target: number | null = null
	private pending = 0
	private readonly restartWith: (time: number) => Promise<void>
	// `superseded`: another restart was asked for while this one ran, so its failure no longer matters.
	private readonly onRestartError: (error: unknown, superseded: boolean) => void

	public constructor(params: {
		restart: (time: number) => Promise<void>
		onRestartError: (error: unknown, superseded: boolean) => void
	}) {
		this.restartWith = params.restart
		this.onRestartError = params.onRestartError
	}

	// Whether any operation is queued or running.
	public get busy(): boolean {
		return this.pending > 0
	}

	// Whether a restart is waiting for its turn.
	public get restartQueued(): boolean {
		return this.target !== null
	}

	public run(operation: () => Promise<void>): Promise<void> {
		this.pending++

		const next = this.chain.then(operation).finally(() => {
			this.pending--
		})

		this.chain = next.catch(() => undefined)

		return next
	}

	public restart(time: number): void {
		const queued = this.target !== null

		this.target = time

		if (queued) {
			return
		}

		void this.run(async () => {
			const target = this.target

			this.target = null

			if (target !== null) {
				await this.restartWith(target)
			}
		}).catch((error: unknown) => {
			this.onRestartError(error, this.target !== null)
		})
	}
}
