import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { SunMoonIcon } from "lucide-react"
import { ThemeCard } from "@/features/settings/components/appearance/themeCard"
import { DriveMemoryCard } from "@/features/settings/components/appearance/driveMemoryCard"

export const Route = createFileRoute("/_app/settings/appearance")({ component: AppearancePage })

function AppearancePage() {
	const { t } = useTranslation("settings")

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 px-4">
				<div className="flex items-center gap-2">
					<SunMoonIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("settingsSectionAppearance")}</h1>
				</div>
			</header>
			<div className="flex flex-1 flex-col overflow-y-auto p-6">
				<div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
					<ThemeCard />
					<DriveMemoryCard />
				</div>
			</div>
		</>
	)
}
