import { Fragment, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, MoreHorizontalIcon, PackageIcon } from "lucide-react"
import { ListFilterInput } from "@/components/listFilterInput"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface ArchiveCrumb {
	id: number
	name: string
}

// A level of the archives holding this one (W6 §6.1 A): an outer archive's root or one of its directories, left for it.
export interface OuterCrumb {
	key: string
	name: string
	onSelect: () => void
}

export interface ArchiveToolbarProps {
	// The archives holding this one and the directories it lies in, outermost first; empty for a file's own archive.
	outer: readonly OuterCrumb[]
	// The archive's name, standing for its root.
	rootName: string
	// Below the root, top down; the last is the directory shown.
	shown: readonly ArchiveCrumb[]
	// The levels between the root and `shown`, folded into "…".
	hidden: readonly ArchiveCrumb[]
	query: string
	searchBoxRef: RefObject<HTMLDivElement | null>
	onNavigate: (dir: number) => void
	onQueryChange: (query: string) => void
}

function Crumb({ name, current, onClick }: { name: string; current: boolean; onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="xs"
			aria-current={current ? "location" : undefined}
			className="max-w-48 min-w-0 shrink"
			onClick={onClick}
		>
			<span className="truncate">{name}</span>
		</Button>
	)
}

function Separator() {
	return (
		<ChevronRightIcon
			aria-hidden="true"
			className="size-3.5 shrink-0 text-muted-foreground"
		/>
	)
}

// Where in the archive the browser is, and its search below there.
export function ArchiveToolbar({ outer, rootName, shown, hidden, query, searchBoxRef, onNavigate, onQueryChange }: ArchiveToolbarProps) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
			<nav
				aria-label={t("previewArchiveBreadcrumbs")}
				className="flex min-w-0 flex-1 items-center gap-0.5"
			>
				{outer.map(crumb => (
					<Fragment key={crumb.key}>
						<Crumb
							name={crumb.name}
							current={false}
							onClick={crumb.onSelect}
						/>
						<Separator />
					</Fragment>
				))}
				{/* Where the trail crosses into an archive held in another. */}
				{outer.length > 0 ? (
					<PackageIcon
						aria-hidden="true"
						data-archive-boundary=""
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				) : null}
				<Crumb
					name={rootName}
					current={shown.length === 0}
					onClick={() => {
						onNavigate(0)
					}}
				/>
				{hidden.length > 0 ? (
					<>
						<Separator />
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("previewArchiveHiddenLevels")}
									/>
								}
							>
								<MoreHorizontalIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent className="w-auto max-w-72">
								{hidden.map(crumb => (
									<DropdownMenuItem
										key={crumb.id}
										onClick={() => {
											onNavigate(crumb.id)
										}}
									>
										<span className="min-w-0 truncate">{crumb.name}</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				) : null}
				{shown.map((crumb, i) => (
					<Fragment key={crumb.id}>
						<Separator />
						<Crumb
							name={crumb.name}
							current={i === shown.length - 1}
							onClick={() => {
								onNavigate(crumb.id)
							}}
						/>
					</Fragment>
				))}
			</nav>
			<div
				ref={searchBoxRef}
				className="w-full sm:w-64"
			>
				<ListFilterInput
					value={query}
					onChange={onQueryChange}
					placeholder={t("previewArchiveSearchPlaceholder")}
					ariaLabel={t("previewArchiveSearchPlaceholder")}
				/>
			</div>
		</div>
	)
}
