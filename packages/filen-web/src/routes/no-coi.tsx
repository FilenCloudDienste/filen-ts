import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ShieldAlertIcon } from "lucide-react"
import { FullScreenNotice, ReloadButton } from "@/components/fullScreenNotice"
import { routeHead } from "@/lib/head/routeHead"
import { i18n } from "@/lib/i18n"

// Terminal page for a browser that did not load the app cross-origin-isolated (COOP/COEP missing).
// Deliberately depends on NOTHING from the SDK — the root gate routes here on a `coi` boot failure and
// always lets it render, so it can never loop back through a gate that will never reach "ready".
export const Route = createFileRoute("/no-coi")({
	head: routeHead({ title: () => [i18n.t("common:noCoiTitle")] }),
	component: NoCoiPage
})

function NoCoiPage() {
	const { t } = useTranslation()

	return (
		<FullScreenNotice
			icon={<ShieldAlertIcon />}
			destructive={true}
			title={t("noCoiTitle")}
			description={t("noCoiBody")}
		>
			<ReloadButton />
		</FullScreenNotice>
	)
}
