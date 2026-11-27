import { Fragment, useState } from "react"
import { useLinkProps, useNavigate } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { ChevronRightIcon } from "lucide-react"
import { canWriteVariant, type DriveVariant } from "@/features/drive/lib/preferences"
import { driveRouteIdFor, type DriveRouteId, splatToUuids } from "@/features/drive/lib/navigate"
import { useDirectoryNamesQuery } from "@/features/drive/queries/drive"
import { canDragVariant } from "@/features/drive/lib/dnd.logic"
import { dropHighlightClass, useDriveDropTarget } from "@/features/drive/hooks/useDriveDropTarget"
import { LISTING_SPRING, TREE_EXPAND_SPRING, armSpringLoad, cancelSpringLoad } from "@/features/drive/lib/springLoad"
import { registerDropTarget } from "@/features/drive/lib/pointerDrag"
import { collapsedCrumbRange, type CrumbCollapseInput } from "@/features/drive/components/breadcrumb.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useElementSize } from "@/lib/useElementSize"
import { cn } from "@filen/shared"
import { KEEP_SELECTION_PROPS } from "@/features/drive/lib/clickAway.logic"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuContent, DropdownMenuLinkItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

const VARIANT_ROOT_LABEL_KEY = {
	drive: "driveMyDrive",
	recents: "driveRecents",
	favorites: "driveFavorites",
	trash: "driveTrash",
	links: "common:driveLinks",
	sharedIn: "common:driveSharedIn",
	sharedOut: "common:driveSharedOut"
} as const satisfies Record<DriveVariant, string>

// Every segment carries the same px-1 (the link's drop-highlight inset), so navigating up doesn't shift
// the ancestors when the old parent turns into the plain current span.
const CRUMB_LINK_CLASS = "rounded-sm px-1 text-muted-foreground hover:text-foreground hover:underline"
const CRUMB_CURRENT_CLASS = "px-1 font-medium text-foreground"
const CRUMB_OVERFLOW_CLASS = "rounded-sm px-1 text-muted-foreground hover:text-foreground"
const TRAIL_CLASS = "flex items-center gap-1.5 text-sm whitespace-nowrap"

export interface BreadcrumbProps {
	variant: DriveVariant
	splat: string
}

// One crumb of the trail: the root (null uuid, empty splat and ancestry) or a directory on the route.
interface Crumb {
	key: string
	label: string
	// The link's splat param — "" for the root crumb, else the ancestor uuid chain.
	splatValue: string
	targetUuid: string | null
	// The crumb's root-to-segment ancestry.
	targetAncestry: readonly string[]
}

interface CrumbTargetProps {
	variant: DriveVariant
	routeId: DriveRouteId
	crumb: Crumb
}

// An ancestor crumb's link and drag-to-move drop target, for the trail's links and the "…" menu's items alike.
function useCrumbTarget({ variant, routeId, crumb }: CrumbTargetProps) {
	const navigate = useNavigate()
	// A drag resting on an ancestor opens it (springLoad.ts), as the link would; files from the system
	// dropped on it upload into it wherever the listing's dropzone would (canWriteVariant, for this crumb).
	const drop = useDriveDropTarget({
		targetUuid: crumb.targetUuid,
		targetAncestry: crumb.targetAncestry,
		routeChain: { parent: undefined },
		targetName: crumb.label,
		disabled: !canDragVariant(variant),
		spring: {
			timing: LISTING_SPRING,
			open: () => {
				void navigate({ to: routeId, params: { _splat: crumb.splatValue } })
			}
		},
		acceptFiles: canWriteVariant(variant, crumb.targetUuid)
	})
	// The link's own ref, merged with the drag engine's registration.
	const linkProps = useLinkProps({ to: routeId, params: { _splat: crumb.splatValue } }, drop.attach)

	return { drop, linkProps }
}

// An ancestor crumb in the trail (gated to the drive variant as a drop target — its own component so the
// drop hook is called once per crumb, never in a loop). The current (last) segment stays a plain span, so
// it is never a target.
function CrumbLink(props: CrumbTargetProps) {
	const { drop, linkProps } = useCrumbTarget(props)

	return (
		<a
			{...linkProps}
			// A crumb link is always an ancestor (the current segment is a plain span), yet the router marks
			// it current whenever its location matches: by prefix, and exactly for the moment a navigation to
			// it has started but this breadcrumb still shows the old path. Link always sets the attribute.
			aria-current={undefined}
			{...drop.handlers}
			className={cn(CRUMB_LINK_CLASS, drop.isOver && "text-foreground", dropHighlightClass(drop))}
		>
			{props.crumb.label}
		</a>
	)
}

function CrumbMenuItem(props: CrumbTargetProps) {
	const { drop, linkProps } = useCrumbTarget(props)

	return (
		<DropdownMenuLinkItem
			closeOnClick={true}
			className={cn(drop.isOver && "bg-accent text-accent-foreground", dropHighlightClass(drop))}
			render={
				<a
					{...linkProps}
					aria-current={undefined}
					{...drop.handlers}
				/>
			}
		>
			<span className="truncate">{props.crumb.label}</span>
		</DropdownMenuLinkItem>
	)
}

interface CrumbOverflowProps {
	variant: DriveVariant
	routeId: DriveRouteId
	crumbs: readonly Crumb[]
}

// The "…" standing in for the crumbs a narrow trail hides, oldest first. A drag resting on it opens the
// menu, whose items are drop targets like the crumbs; not modal, so the drag still reaches the page.
function CrumbOverflow({ variant, routeId, crumbs }: CrumbOverflowProps) {
	const { t } = useTranslation("drive")
	const [open, setOpen] = useState(false)
	const draggable = canDragVariant(variant)

	return (
		<li
			className="shrink-0"
			ref={element => {
				if (element === null || !draggable) {
					return
				}

				const owner = {}
				const unregister = registerDropTarget(element, {
					accepts: () => false,
					springs: () => true,
					update: (state, target) => {
						if (state?.spring === true) {
							armSpringLoad(owner, target, TREE_EXPAND_SPRING, () => {
								setOpen(true)
							})
						} else {
							cancelSpringLoad(owner)
						}
					},
					drop: () => undefined
				})

				return () => {
					cancelSpringLoad(owner)
					unregister()
				}
			}}
		>
			<DropdownMenu
				open={open}
				onOpenChange={setOpen}
				modal={false}
			>
				<DropdownMenuTrigger
					aria-label={t("driveBreadcrumbHidden")}
					className={CRUMB_OVERFLOW_CLASS}
				>
					…
				</DropdownMenuTrigger>
				<DropdownMenuContent>
					{crumbs.map(crumb => (
						<CrumbMenuItem
							key={crumb.key}
							variant={variant}
							routeId={routeId}
							crumb={crumb}
						/>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	)
}

// The trail's geometry in px, matching TRAIL_CLASS (gap-1.5), the chevrons (size-3.5) and each crumb's px-1.
const TRAIL_GAP = 6
const TRAIL_SEPARATOR = 14
const CRUMB_PADDING = 8

let measureContext: CanvasRenderingContext2D | null | undefined = undefined

// A label's rendered width, from the text metrics alone: no hidden copy of the trail in the DOM.
function textWidth(text: string, font: string): number {
	measureContext ??= document.createElement("canvas").getContext("2d")

	if (measureContext === null) {
		return 0
	}

	measureContext.font = font

	return measureContext.measureText(text).width
}

// Every crumb's natural width in the slot's font: regular for the links, medium for the current directory.
function trailMeasure(slot: HTMLElement, labels: readonly string[]): Omit<CrumbCollapseInput, "available"> {
	const style = getComputedStyle(slot)
	const font = (weight: number) => `${String(weight)} ${style.fontSize} ${style.fontFamily}`
	const last = labels.length - 1

	return {
		widths: labels.map((label, index) => textWidth(label, font(index === last ? 500 : 400)) + CRUMB_PADDING),
		separator: TRAIL_SEPARATOR,
		gap: TRAIL_GAP,
		ellipsis: textWidth("…", font(400)) + CRUMB_PADDING
	}
}

// Root (an empty splat) renders its variant's own label directly — nothing to resolve, since the
// URL itself carries no ancestor uuids. A non-empty splat occurs on the three splat routes (drive,
// shared-in, shared-out); `variant` picks how its crumb names resolve (useDirectoryNamesQuery).
export function Breadcrumb({ variant, splat }: BreadcrumbProps) {
	const { t } = useTranslation(["drive", "common"])
	const rootLabel = t(VARIANT_ROOT_LABEL_KEY[variant])
	const uuids = splatToUuids(splat)
	// One route id for every crumb link — the shared variants link within their own splat routes, so
	// a breadcrumb ancestor click stays on "/shared-in/$" / "/shared-out/$" instead of jumping to the
	// owned "/drive/$" (see features/drive/lib/navigate.ts's driveRouteIdFor). All three routes take the same
	// splat param, so only the `to` differs.
	const routeId = driveRouteIdFor(variant)
	const namesQuery = useDirectoryNamesQuery(uuids, variant)
	const [slot, setSlot] = useState<HTMLDivElement | null>(null)
	const available = useElementSize(slot).width

	const root: Crumb = { key: "root", label: rootLabel, splatValue: "", targetUuid: null, targetAncestry: [] }
	// Whatever useDirectoryNamesQuery couldn't resolve for one uuid (not found, undecryptable meta) falls
	// back to the raw uuid — a gap in an otherwise-resolved path degrades one segment, never the breadcrumb.
	const crumbs: Crumb[] | null =
		uuids.length === 0
			? [root]
			: namesQuery.status === "success"
				? [
						root,
						...uuids.map((uuid, index) => ({
							key: uuid,
							label: namesQuery.data[uuid] ?? uuid,
							splatValue: uuids.slice(0, index + 1).join("/"),
							targetUuid: uuid,
							targetAncestry: uuids.slice(0, index + 1)
						}))
					]
				: null
	// Measured only once the slot has a width; until then (and while names resolve) nothing is folded.
	const hidden =
		crumbs !== null && slot !== null && available > 0
			? collapsedCrumbRange({
					...trailMeasure(
						slot,
						crumbs.map(crumb => crumb.label)
					),
					available
				})
			: { start: 0, end: 0 }
	const crumbCount = crumbs?.length ?? 0
	const lastIndex = crumbCount - 1

	function renderCrumb(crumb: Crumb, index: number) {
		const isLast = index === lastIndex

		return (
			<Fragment key={crumb.key}>
				{index > 0 && index !== hidden.end ? (
					<li aria-hidden>
						<ChevronRightIcon className="size-3.5 text-muted-foreground" />
					</li>
				) : null}
				<li className={isLast ? "min-w-0" : "shrink-0"}>
					{isLast ? (
						<span
							aria-current="page"
							className={cn(CRUMB_CURRENT_CLASS, "block truncate")}
						>
							{crumb.label}
						</span>
					) : (
						<CrumbLink
							variant={variant}
							routeId={routeId}
							crumb={crumb}
						/>
					)}
				</li>
			</Fragment>
		)
	}

	return (
		// The trail's slot is the header row's only yielding item — the action cluster beside it is shrink-0
		// and its buttons must never be pushed past the card edge. The slot takes the free width (what the
		// collapse measures against); the nav inside stays as wide as its crumbs, so the header's empty space
		// beside it still clears the selection.
		<div
			ref={setSlot}
			className="flex min-w-0 flex-1 overflow-hidden text-sm"
		>
			<nav
				aria-label={t("driveBreadcrumbLabel")}
				className="min-w-0 overflow-hidden"
				{...KEEP_SELECTION_PROPS}
			>
				<ol className={TRAIL_CLASS}>
					{crumbs === null ? (
						<>
							<li className="shrink-0">
								<CrumbLink
									variant={variant}
									routeId={routeId}
									crumb={root}
								/>
							</li>
							<li aria-hidden>
								<ChevronRightIcon className="size-3.5 text-muted-foreground" />
							</li>
							{namesQuery.status === "error" ? (
								<li className="text-destructive">{errorLabel(namesQuery.error)}</li>
							) : (
								// Spinner carries its own role="status"/aria-label — not aria-hidden, unlike the
								// decorative chevrons, so assistive tech still hears the loading state.
								<li>
									<Spinner className="size-3.5 text-muted-foreground" />
								</li>
							)}
						</>
					) : (
						crumbs.map((crumb, index) => {
							if (index === hidden.start && hidden.end > hidden.start) {
								return (
									<Fragment key="overflow">
										{index > 0 ? (
											<li aria-hidden>
												<ChevronRightIcon className="size-3.5 text-muted-foreground" />
											</li>
										) : null}
										<CrumbOverflow
											variant={variant}
											routeId={routeId}
											crumbs={crumbs.slice(hidden.start, hidden.end)}
										/>
										<li aria-hidden>
											<ChevronRightIcon className="size-3.5 text-muted-foreground" />
										</li>
									</Fragment>
								)
							}

							return index > hidden.start && index < hidden.end ? null : renderCrumb(crumb, index)
						})
					)}
				</ol>
			</nav>
		</div>
	)
}
