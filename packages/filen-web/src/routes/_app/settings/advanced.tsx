import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SlidersHorizontalIcon } from "lucide-react"
import { TransferConfigCard } from "@/features/settings/components/advanced/transferConfigCard"
import { LogsCard } from "@/features/settings/components/advanced/logsCard"
import { AboutCard } from "@/features/settings/components/advanced/aboutCard"

export const Route = createFileRoute("/_app/settings/advanced")({ component: AdvancedPage })

function AdvancedPage() {
	const { t } = useTranslation("settings")

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<SlidersHorizontalIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionAdvanced")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
					<TransferConfigCard />
					<LogsCard />
					<AboutCard />
				</div>
			</div>
		</>
	)
}
