import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/shallow"
import { formatBytesFixed, formatBytesPerSecond, formatSecondsToMediaClock } from "@filen/shared"
import { isDriveJobDirection, useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { driveJobRate } from "@/features/drive/lib/driveJobs.logic"
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

// A transfer's speed and time left. A drive job reads its rate off its job, which also counts the files
// it has not reached yet; anything else off its own rolling window. Shallow, so a job update that leaves
// the rate as it was re-renders nothing.
export function useTransferRate(transfer: Transfer): TransferRate | null {
	const isJob = isDriveJobDirection(transfer.direction)
	const jobRate = useDriveJobsStore(
		useShallow(state => {
			const job = isJob ? state.jobs[transfer.id] : undefined

			return job === undefined ? null : driveJobRate(job)
		})
	)
	const samples = useTransfersStore(state => (isJob ? undefined : state.rowSpeedSamples[transfer.id]))

	if (isJob) {
		return jobRate
	}

	return transferRate(transfer, samples ?? [])
}
