export function isTimestampSameDay(timestamp1: number, timestamp2: number): boolean {
	const diff = timestamp1 - timestamp2

	if (diff < -86400000 || diff > 86400000) {
		return false
	}

	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)

	return date1.getFullYear() === date2.getFullYear() && date1.getMonth() === date2.getMonth() && date1.getDate() === date2.getDate()
}

export function isTimestampSameMinute(timestamp1: number, timestamp2: number): boolean {
	const diff = Math.abs(timestamp1 - timestamp2)

	if (diff > 120000) {
		return false
	}

	const date1 = new Date(timestamp1)
	const date2 = new Date(timestamp2)

	if (
		date1.getFullYear() !== date2.getFullYear() ||
		date1.getMonth() !== date2.getMonth() ||
		date1.getDate() !== date2.getDate() ||
		date1.getHours() !== date2.getHours()
	) {
		return false
	}

	const minuteDiff = Math.abs(date1.getMinutes() - date2.getMinutes())

	return minuteDiff <= 2
}

export function formatSecondsToHHMM(seconds: number): string {
	if (seconds < 0 || seconds !== seconds) {
		return "00:00"
	}

	const hours = (seconds / 3600) | 0
	const minutes = ((seconds % 3600) / 60) | 0
	const h1 = (hours / 10) | 0
	const h2 = hours % 10
	const m1 = (minutes / 10) | 0
	const m2 = minutes % 10

	return String(h1) + h2 + ":" + m1 + m2
}

export function formatSecondsToMMSS(seconds: number): string {
	if (seconds < 0 || seconds !== seconds) {
		return "00:00"
	}

	const minutes = (seconds / 60) | 0
	const remainingSeconds = seconds % 60 | 0
	const m1 = (minutes / 10) | 0
	const m2 = minutes % 10
	const s1 = (remainingSeconds / 10) | 0
	const s2 = remainingSeconds % 10

	return String(m1) + m2 + ":" + s1 + s2
}

export function getTimeRemaining(endTimestamp: number): {
	total: number
	days: number
	hours: number
	minutes: number
	seconds: number
} {
	const total = endTimestamp - Date.now()
	const totalSeconds = (total / 1000) | 0
	const days = (totalSeconds / 86400) | 0
	const hours = ((totalSeconds % 86400) / 3600) | 0
	const minutes = ((totalSeconds % 3600) / 60) | 0
	const seconds = totalSeconds % 60

	return {
		total,
		days,
		hours,
		minutes,
		seconds
	}
}
