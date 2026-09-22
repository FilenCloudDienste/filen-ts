import { type TFunction } from "i18next"
import { formatRelativeTimeCore } from "@filen/shared"

// Locale-aware absolute fallback used once a timestamp is older than the cutoff. Kept minimal (no
// clock time) — the surfaces this feeds (note rows, later chat/events rows) want a compact date, not a
// full datetime. `undefined` locale defers to the runtime's own locale, same posture as the rest of
// the app's date rendering.
function defaultAbsolute(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

// Formats a millisecond timestamp as a relative label ("Just now", "5 minutes ago", "2 hours ago",
// "3 days ago") for the recent past, falling back to an absolute date once it is older than the
// shared cutoff. `t` is passed in rather than imported so this module carries no i18n dependency.
//
// `t` must resolve the shared `relative*` keys (locales/en/common.ts) — callers on a feature namespace
// pass a common-bound `t` (useTranslation("common")). Clock skew / future timestamps collapse to
// "Just now" rather than a negative count.
export function formatRelativeTime(timestamp: number, t: TFunction, options?: { absolute?: (timestamp: number) => string }): string {
	return formatRelativeTimeCore(
		timestamp,
		// TFunction's overloaded signature isn't itself assignable to a plain (key, options?) => string
		// under this app's exactOptionalPropertyTypes — narrowing `opts` before calling keeps each branch
		// concrete instead of a union-with-undefined, which is what TFunction actually accepts.
		(key, opts) => (opts === undefined ? t(key) : t(key, opts)),
		{
			justNow: "relativeJustNow",
			minutesAgo: "relativeMinutesAgo",
			hoursAgo: "relativeHoursAgo",
			daysAgo: "relativeDaysAgo"
		},
		options?.absolute ?? defaultAbsolute
	)
}
