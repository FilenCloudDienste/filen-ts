import { useTranslation } from "react-i18next"
import { HardDriveIcon } from "lucide-react"
import { EmptyMessage } from "@/components/emptyMessage"
import { LoadingState } from "@/components/loadingState"
import { useMountsStore } from "@/features/mounts/lib/mountsStore"

// The content card at the bare /mounts: loading until the first overview, then the prompt to pick the drive or a
// server from the sidebar.
export function MountsPlaceholder() {
	const { t } = useTranslation("mounts")
	const loaded = useMountsStore(state => state.overview !== null)

	if (!loaded) {
		return <LoadingState size="lg" />
	}

	return (
		<EmptyMessage
			icon={HardDriveIcon}
			title={t("placeholderTitle")}
			description={t("placeholderDescription")}
		/>
	)
}
