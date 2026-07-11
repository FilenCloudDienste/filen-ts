import type { ComponentType } from "react"
import { useTranslation } from "react-i18next"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Badge } from "@/components/ui/badge"

interface SettingsPlaceholderProps {
	icon: ComponentType<{ className?: string }>
	title: string
}

// Present-but-minimal stand-in for the Events/Billing sections (both ship in a later wave — see the
// settings study's WAVE SKETCH). Never a broken/dead link: the sidebar nav item and route both work,
// this is just what renders at the destination today.
function SettingsPlaceholder({ icon: Icon, title }: SettingsPlaceholderProps) {
	const { t } = useTranslation(["settings", "common"])

	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon />
				</EmptyMedia>
				<EmptyTitle>
					{title} <Badge variant="secondary">{t("common:comingSoon")}</Badge>
				</EmptyTitle>
				<EmptyDescription>{t("settingsPlaceholderBody")}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	)
}

export { SettingsPlaceholder }
