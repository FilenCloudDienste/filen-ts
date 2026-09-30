import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { useMediaClockSeconds, useMediaDuration } from "@/lib/media/useMediaState"

const TIME_CLASS = "shrink-0 text-xs text-muted-foreground tabular-nums"

// Playhead and length readouts bound to a media element, each re-rendering on its own: the playhead once
// a second, the length when it becomes known.
export function MediaCurrentTime({ media, className }: { media: HTMLMediaElement | null; className?: string | undefined }) {
	return <span className={cn(TIME_CLASS, className)}>{formatSecondsToMediaClock(useMediaClockSeconds(media))}</span>
}

export function MediaDuration({ media, className }: { media: HTMLMediaElement | null; className?: string | undefined }) {
	return <span className={cn(TIME_CLASS, className)}>{formatSecondsToMediaClock(useMediaDuration(media))}</span>
}
