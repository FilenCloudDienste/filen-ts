import { useEffect } from "react"
import { clampedRatio } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { transfersIndexOf, useTransfersStore } from "@/features/transfers/store/useTransfersStore"
import { percentFormat } from "@/features/transfers/components/transferRow.logic"
import { titleProgress } from "@/features/transfers/lib/titleProgress.logic"

// The overall transfer percent in the tab's title while the tab is hidden (titleProgress.logic.ts). Mounted once by
// the shell. Read off the rows' index, which a store write keeps current, and only while hidden: a visible tab's
// progress ticks cost one comparison.
export function useTransfersTitleProgress(): void {
	useEffect(() => {
		const progress = titleProgress(document, (percent, title) =>
			i18n.t("transfers:transfersTitleProgress", { percent: percentFormat(undefined).format(percent / 100), title })
		)

		function sync(): void {
			if (!document.hidden) {
				progress.update(null)

				return
			}

			const index = transfersIndexOf(useTransfersStore.getState().transfers)

			progress.update(index.activeCount === 0 ? null : clampedRatio(index.activeTransferred, index.activeSize, 100))
		}

		const unsubscribe = useTransfersStore.subscribe((state, previous) => {
			if (state.transfers !== previous.transfers) {
				sync()
			}
		})

		document.addEventListener("visibilitychange", sync)

		return () => {
			unsubscribe()
			document.removeEventListener("visibilitychange", sync)
			progress.update(null)
		}
	}, [])
}
