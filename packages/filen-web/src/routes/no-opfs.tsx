import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { DatabaseXIcon } from "lucide-react"
import { FullScreenNotice, ReloadButton } from "@/components/fullScreenNotice"
import { routeHead } from "@/lib/head/routeHead"
import { desktopPlatform } from "@/lib/desktop"
import { i18n } from "@/lib/i18n"

// Terminal page for a browser that could not open the persistent OPFS storage the app requires (SAH
// pool install/open failed — disabled, private browsing, or an unsupported browser). Deliberately
// depends on NOTHING beyond i18n/UI primitives — mirrors /no-coi: the root gate routes here on an
// `opfs` boot failure and always lets it render, so it can never loop back through a gate that will
// never reach "ready".
export const Route = createFileRoute("/no-opfs")({
	head: routeHead({ title: () => [i18n.t("common:noOpfsTitle")] }),
	component: NoOpfsPage
})

function NoOpfsPage() {
	const { t } = useTranslation()

	return (
		<FullScreenNotice
			icon={<DatabaseXIcon />}
			destructive={true}
			title={t("noOpfsTitle")}
			// No private window or other browser to switch to in the desktop app.
			description={t(desktopPlatform() === undefined ? "noOpfsBody" : "desktopNoOpfsBody")}
		>
			<ReloadButton />
		</FullScreenNotice>
	)
}
