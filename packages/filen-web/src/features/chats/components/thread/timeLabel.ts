import type { TFunction } from "i18next"
import { dayKind, formatClockTime, formatFullDate } from "@/features/chats/lib/time"

// The day in words when it is today or yesterday, else the full date, followed by the clock time.
export function dayTimeLabel(t: TFunction<"chats">, timestamp: bigint): string {
	const kind = dayKind(timestamp)
	const time = formatClockTime(timestamp)

	if (kind === "today") {
		return t("chatTimeHeaderToday", { time })
	}

	if (kind === "yesterday") {
		return t("chatTimeHeaderYesterday", { time })
	}

	return t("chatTimeHeaderDate", { date: formatFullDate(timestamp), time })
}
