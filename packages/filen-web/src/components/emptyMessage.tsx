import type { ComponentProps, ComponentType, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { SearchXIcon } from "lucide-react"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Icon + title (+ description) empty state; children render as the action row under the header, and
// the remaining props land on the Empty root (className, role, data-testid).
export function EmptyMessage({
	icon: Icon,
	title,
	description,
	children,
	...props
}: Omit<ComponentProps<typeof Empty>, "title"> & { icon: ComponentType; title: ReactNode; description?: ReactNode }) {
	return (
		<Empty {...props}>
			<EmptyHeader>
				<EmptyMedia>
					<Icon />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{description ? <EmptyDescription>{description}</EmptyDescription> : null}
			</EmptyHeader>
			{children ? <EmptyContent>{children}</EmptyContent> : null}
		</Empty>
	)
}

// A filter or search that matched nothing.
export function NoResultsMessage() {
	const { t } = useTranslation()

	return (
		<EmptyMessage
			icon={SearchXIcon}
			title={t("searchNoResults")}
		/>
	)
}
