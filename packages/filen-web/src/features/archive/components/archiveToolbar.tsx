import { Fragment, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon, MoreHorizontalIcon, PackageIcon } from "lucide-react"
import { ListFilterInput } from "@/components/listFilterInput"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface ArchiveCrumb {
	id: number
	name: string
}

// A level of the archives holding this one: an outer archive's root or one of its directories, left for it.
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
	onNavigate: (dir: number) => void
	// The search below the directory shown; left out where nothing is listed to search (an inner archive's gate, say).
	search?: { query: string; onQueryChange: (query: string) => void } | undefined
	searchBoxRef?: RefObject<HTMLDivElement | null> | undefined
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

// Outer crumbs shown in full; the earlier ones fold into a "…" of their own.
const OUTER_VISIBLE_CRUMBS = 2

// Where in the archive the browser is, and its search below there.
export function ArchiveToolbar({ outer, rootName, shown, hidden, onNavigate, search, searchBoxRef }: ArchiveToolbarProps) {
	const { t } = useTranslation("preview")
	const folded = outer.slice(0, Math.max(0, outer.length - OUTER_VISIBLE_CRUMBS))
	const outerShown = outer.slice(folded.length)

	return (
		<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
			<nav
				aria-label={t("previewArchiveBreadcrumbs")}
				className="flex min-w-0 flex-1 items-center gap-0.5"
			>
				{folded.length > 0 ? (
					<>
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger
									render={
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
									}
								/>
								<TooltipContent>{t("previewArchiveHiddenLevels")}</TooltipContent>
							</Tooltip>
							<DropdownMenuContent className="w-auto max-w-72">
								{folded.map(crumb => (
									<DropdownMenuItem
										key={crumb.key}
										onClick={crumb.onSelect}
									>
										<span className="min-w-0 truncate">{crumb.name}</span>
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
						<Separator />
					</>
				) : null}
				{outerShown.map(crumb => (
					<Fragment key={crumb.key}>
						<Crumb
							name={crumb.name}
							current={false}
							onClick={crumb.onSelect}
						/>
						<Separator />
					</Fragment>
				))}
				{/* Where the trail crosses into an archive held in another, named for a screen reader. */}
				{outer.length > 0 ? (
					<span
						data-archive-boundary=""
						className="flex shrink-0 items-center"
					>
						<PackageIcon
							aria-hidden="true"
							className="size-3.5 text-muted-foreground"
						/>
						<span className="sr-only">{t("previewArchiveNestedBoundary")}</span>
					</span>
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
							<Tooltip>
								<TooltipTrigger
									render={
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
									}
								/>
								<TooltipContent>{t("previewArchiveHiddenLevels")}</TooltipContent>
							</Tooltip>
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
			{search === undefined ? null : (
				<div
					ref={searchBoxRef}
					className="w-full sm:w-64"
				>
					<ListFilterInput
						value={search.query}
						onChange={search.onQueryChange}
						placeholder={t("previewArchiveSearchPlaceholder")}
						ariaLabel={t("previewArchiveSearchPlaceholder")}
					/>
				</div>
			)}
		</div>
	)
}
