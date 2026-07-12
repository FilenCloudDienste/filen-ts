import { type TFunction } from "i18next"

// Number of days after which a relative label gives way to the absolute date — mirrors filen-mobile's
// lib/time.ts RELATIVE_TIME_CUTOFF_DAYS. Past this, "N days ago" reads worse than a plain date.
const RELATIVE_TIME_CUTOFF_DAYS = 7

// Locale-aware absolute fallback used once a timestamp is older than the cutoff. Kept minimal (no
// clock time) — the surfaces this feeds (note rows, later chat/events rows) want a compact date, not a
// full datetime. `undefined` locale defers to the runtime's own locale, same posture as the rest of
// the app's date rendering.
function defaultAbsolute(timestamp: number): string {
	return new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

// Formats a millisecond timestamp as a relative label ("Just now", "5 minutes ago", "2 hours ago",
// "3 days ago") for the recent past, falling back to an absolute date once it is older than
// RELATIVE_TIME_CUTOFF_DAYS. Ports filen-mobile's formatRelativeTime semantics 1:1. Pure aside from
// Date.now(), no Intl in the relative branches (the i18next plural pipeline handles the wording), and
// `t` is passed in rather than imported so this module carries no i18n dependency.
//
// `t` must resolve the shared `relative*` keys (locales/en/common.ts) — callers on a feature namespace
// pass a common-bound `t` (useTranslation("common")). Clock skew / future timestamps collapse to
// "Just now" rather than a negative count.
export function formatRelativeTime(timestamp: number, t: TFunction, options?: { absolute?: (timestamp: number) => string }): string {
	const diffSeconds = Math.floor((Date.now() - timestamp) / 1000)

	if (diffSeconds < 60) {
		return t("relativeJustNow")
	}

	const diffMinutes = Math.floor(diffSeconds / 60)

	if (diffMinutes < 60) {
		return t("relativeMinutesAgo", { count: diffMinutes })
	}

	const diffHours = Math.floor(diffMinutes / 60)

	if (diffHours < 24) {
		return t("relativeHoursAgo", { count: diffHours })
	}

	const diffDays = Math.floor(diffHours / 24)

	if (diffDays < RELATIVE_TIME_CUTOFF_DAYS) {
		return t("relativeDaysAgo", { count: diffDays })
	}

	return (options?.absolute ?? defaultAbsolute)(timestamp)
}
