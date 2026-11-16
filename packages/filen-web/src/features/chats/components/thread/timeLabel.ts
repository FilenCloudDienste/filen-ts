import type { TFunction } from "i18next"
import { dayKind, formatClockTime, formatFullDate, formatShortDate } from "@/features/chats/lib/time"

// The day in words when it is today or yesterday, else the date (full in a time header, numeric in a run's
// header line), followed by the clock time.
export function dayTimeLabel(t: TFunction<"chats">, timestamp: bigint, short: boolean): string {
	const kind = dayKind(timestamp)
	const time = formatClockTime(timestamp)

	if (kind === "today") {
		return t("chatTimeHeaderToday", { time })
	}

	if (kind === "yesterday") {
		return t("chatTimeHeaderYesterday", { time })
	}

	return t("chatTimeHeaderDate", { date: short ? formatShortDate(timestamp) : formatFullDate(timestamp), time })
}
