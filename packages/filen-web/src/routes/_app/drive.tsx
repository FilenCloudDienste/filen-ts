import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { FolderClosedIcon, SearchIcon, PlusIcon, ListIcon, LayoutGridIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

// Drive content pane: the module top bar (title, in-directory search, view toggle, primary action)
// over an empty state. No listing is wired yet — the search / New / grid controls are disabled
// placeholders establishing the top-bar composition; the real directory listing lands later.
export const Route = createFileRoute("/_app/drive")({ component: DrivePage })

function DrivePage() {
	const { t } = useTranslation(["drive", "common"])

	return (
		<>
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
				<div className="flex items-center gap-2">
					<FolderClosedIcon className="size-4 text-muted-foreground" />
					<h1 className="font-heading text-base font-medium tracking-tight">{t("common:moduleDrive")}</h1>
				</div>
				<div className="ml-auto flex items-center gap-2">
					<div className="relative hidden sm:block">
						<SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							className="w-56 pl-8"
							placeholder={t("driveSearch")}
							disabled
						/>
					</div>
					<div className="flex items-center gap-0.5 rounded-2xl border border-border p-0.5">
						<Button
							variant="secondary"
							size="icon-sm"
							aria-label={t("driveViewList")}
							disabled
						>
							<ListIcon />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							className="text-muted-foreground"
							aria-label={t("driveViewGrid")}
							disabled
						>
							<LayoutGridIcon />
						</Button>
					</div>
					<Button disabled>
						<PlusIcon data-icon="inline-start" />
						{t("driveNew")}
					</Button>
				</div>
			</header>
			<div className="flex flex-1 items-center justify-center overflow-auto p-6">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FolderClosedIcon />
						</EmptyMedia>
						<EmptyTitle>{t("driveEmptyTitle")}</EmptyTitle>
						<EmptyDescription>{t("driveEmptyBody")}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		</>
	)
}
