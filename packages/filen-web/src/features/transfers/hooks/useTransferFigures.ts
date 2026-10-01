import { useTranslation } from "react-i18next"
import { copyJobRate, formatBytesFixed, formatBytesPerSecond, formatSecondsToMediaClock } from "@filen/shared"
import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { useCopyJobsStore } from "@/features/transfers/store/useCopyJobsStore"
import { percentFormat, runningPercentFraction, transferRate, type TransferRate } from "@/features/transfers/components/transferRow.logic"

export interface RunningFigures {
	transferred: number
	size: number
	// 0-100.
	percent: number
	etaSeconds: number | null
	bytesPerSecond: number | null
}

export interface RunningDetails {
	// "312 MiB of 842 MiB · 37% · 2:05 left · 4.2 MB/s"
	full: string
	// The percent alone, null while the size is unknown.
	percent: string | null
	// "37% · 2:05 left · 4.2 MB/s", for a single row's column.
	medium: string
	// "37% · 2:05 left", for a tile.
	short: string
}

// A running transfer's figures as every surface words them (the transfers screen, the listing's pending
// rows). Live figures keep their decimals (formatBytesFixed), so a tick never changes their length, and
// the speed goes last: it changes length all the time and there it has nothing to push.
export function useRunningDetails(): (figures: RunningFigures) => RunningDetails {
	const { t, i18n } = useTranslation("transfers")

	return ({ transferred, size, percent, etaSeconds, bytesPerSecond }) => {
		const percentText = size > 0 ? percentFormat(i18n.language).format(runningPercentFraction(percent)) : null
		const timeLeft = etaSeconds === null ? null : t("transfersRowTimeLeft", { eta: formatSecondsToMediaClock(etaSeconds) })
		const speed = bytesPerSecond === null || bytesPerSecond <= 0 ? null : formatBytesPerSecond(bytesPerSecond)

		return {
			full: [
				size > 0
					? t("transfersRowBytesProgress", { done: formatBytesFixed(transferred), total: formatBytesFixed(size) })
					: formatBytesFixed(transferred),
				percentText,
				timeLeft,
				speed
			]
				.filter(part => part !== null)
				.join(" · "),
			percent: percentText,
			medium: [percentText, timeLeft, speed].filter(part => part !== null).join(" · "),
			short: [percentText, timeLeft].filter(part => part !== null).join(" · ")
		}
	}
}

// A transfer's speed and time left. A copy reads its rate off its job, which also counts the files it
// has not reached yet; anything else off its own rolling window.
export function useTransferRate(transfer: Transfer): TransferRate | null {
	const job = useCopyJobsStore(state => (transfer.direction === "copy" ? state.jobs[transfer.id] : undefined))
	const samples = useTransfersStore(state => state.rowSpeedSamples[transfer.id])

	if (transfer.direction === "copy") {
		return job === undefined ? null : copyJobRate(job)
	}

	return transferRate(transfer, samples ?? [])
}
