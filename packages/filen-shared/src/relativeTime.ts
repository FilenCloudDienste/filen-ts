// Number of days after which a relative label gives way to the absolute date — past this,
// "N days ago" reads worse than a plain date.
export const RELATIVE_TIME_CUTOFF_DAYS = 7

// Pure relative-time ladder: "just now" under a minute, then minutes/hours/days, falling back to
// `absolute` once `timestampMs` is older than RELATIVE_TIME_CUTOFF_DAYS. Both the translator and
// the absolute formatter are required — this module carries no i18n dependency and bakes in no
// platform-specific default, so each app supplies its own key casing and its own absolute-date
// output. `K` is inferred from `keys`, so an app's own typed translator (whose accepted keys are
// a literal union, not `string`) stays assignable without widening to `(key: string, ...) => string`.
export function formatRelativeTimeCore<K extends string>(
	timestampMs: number,
	t: (key: K, options?: { count: number }) => string,
	keys: {
		justNow: K
		minutesAgo: K
		hoursAgo: K
		daysAgo: K
	},
	absolute: (timestampMs: number) => string
): string {
	const diffSeconds = Math.floor((Date.now() - timestampMs) / 1000)

	// Clock skew / future timestamps collapse to "just now" rather than a negative count.
	if (diffSeconds < 60) {
		return t(keys.justNow)
	}

	const diffMinutes = Math.floor(diffSeconds / 60)

	if (diffMinutes < 60) {
		return t(keys.minutesAgo, { count: diffMinutes })
	}

	const diffHours = Math.floor(diffMinutes / 60)

	if (diffHours < 24) {
		return t(keys.hoursAgo, { count: diffHours })
	}

	const diffDays = Math.floor(diffHours / 24)

	if (diffDays < RELATIVE_TIME_CUTOFF_DAYS) {
		return t(keys.daysAgo, { count: diffDays })
	}

	return absolute(timestampMs)
}
