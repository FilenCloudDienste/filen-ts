import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { CheckIcon, type LucideIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { rememberLastOpened, useLastOpened } from "@/features/shell/lib/lastOpened"
import {
	RAIL_CHILD_ROUTE,
	activeRailChild,
	bubbleRailDot,
	railChildActive,
	railGroupTarget,
	type RailChildId,
	type RailDot,
	type RailGroupId
} from "@/features/shell/lib/railGroups.logic"
import { railItemClass } from "@/features/shell/lib/railItem"
import { RailStatusDot } from "@/features/shell/components/railProgressBar"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuLinkItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

export interface RailGroupChild {
	id: RailChildId
	label: string
	icon: LucideIcon
	dot: RailDot
	// The child's own accessible status while it shows a dot.
	statusLabel?: string | undefined
}

// Hover intent: the flyout opens once the pointer rests this long, and waits this long before closing, so a
// pass across the rail opens nothing and the pointer can cross the gap into it.
const HOVER_OPEN_DELAY_MS = 150
const HOVER_CLOSE_DELAY_MS = 150

// A group icon. A click (Enter) goes to the child used last, which reopens its own last item; resting the
// pointer on it, ArrowRight or ArrowDown opens the flyout listing every child. Touch has no hover, so a tap
// opens the flyout instead of navigating.
export function RailGroup({
	group,
	label,
	icon: Icon,
	items,
	pathname,
	reordering
}: {
	group: RailGroupId
	label: string
	icon: LucideIcon
	items: readonly RailGroupChild[]
	pathname: string
	reordering: boolean
}) {
	const { t } = useTranslation("common")
	const [open, setOpen] = useState(false)
	const pointerTypeRef = useRef("mouse")
	const stored = useLastOpened(group)
	const activeChild = activeRailChild(group, pathname)
	// The child visited in this session, so the click target follows navigation without waiting on the store.
	const [visited, setVisited] = useState<RailChildId | null>(null)

	if (activeChild !== null && activeChild !== visited) {
		setVisited(activeChild)
	}

	const target = railGroupTarget(group, visited ?? stored)
	const dot = bubbleRailDot(items.map(item => item.dot))
	const status = dot === null ? undefined : items.find(item => item.dot === dot)?.statusLabel

	useEffect(() => {
		if (activeChild !== null) {
			rememberLastOpened(group, activeChild)
		}
	}, [group, activeChild])

	return (
		<DropdownMenu
			open={open && !reordering}
			onOpenChange={(next, details) => {
				// A pointer press navigates rather than toggling; only touch, which never hovers, opens by press.
				if (next && details.reason === "trigger-press" && pointerTypeRef.current !== "touch") {
					details.cancel()

					return
				}

				setOpen(next)
			}}
		>
			<DropdownMenuTrigger
				nativeButton={false}
				openOnHover={!reordering}
				delay={HOVER_OPEN_DELAY_MS}
				closeDelay={HOVER_CLOSE_DELAY_MS}
				onKeyDown={event => {
					// Alt+Arrow reorders the rail (useRailReorder, on the slot around this): the menu must not open on it.
					if (event.altKey) {
						event.preventBaseUIHandler()

						return
					}

					if (event.key !== "ArrowRight" || event.ctrlKey || event.metaKey || event.shiftKey) {
						return
					}

					event.preventDefault()
					// The menu opens from the keyboard on its list axis (ArrowDown), highlighting the first child; the
					// flyout sits to the right, so ArrowRight takes the same path.
					event.currentTarget.dispatchEvent(
						new globalThis.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })
					)
				}}
				render={
					<Link
						to={RAIL_CHILD_ROUTE[target]}
						aria-current={activeChild === null ? undefined : "page"}
						aria-label={status === undefined ? label : t("railGroupWithStatus", { group: label, status })}
						className={cn(railItemClass(activeChild !== null), "relative")}
						onPointerDown={event => {
							pointerTypeRef.current = event.pointerType
						}}
						onClick={event => {
							if (pointerTypeRef.current === "touch") {
								event.preventDefault()

								return
							}

							setOpen(false)
						}}
					/>
				}
			>
				<Icon />
				{dot === null ? null : (
					<RailStatusDot
						dot={dot}
						className="absolute top-1 right-1 ring-2 ring-canvas"
					/>
				)}
				{/* The flyout affordance: a small corner triangle, as tool groups mark more behind one icon. */}
				<span
					aria-hidden="true"
					className="absolute right-1 bottom-1 size-1.5 bg-current opacity-50 [clip-path:polygon(100%_0,100%_100%,0_100%)]"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="right"
				align="start"
				sideOffset={8}
				className="min-w-44"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{label}</DropdownMenuLabel>
					{items.map(item => {
						const ItemIcon = item.icon
						const current = railChildActive(item.id, pathname)

						return (
							<DropdownMenuLinkItem
								key={item.id}
								closeOnClick={true}
								aria-label={item.statusLabel ?? item.label}
								render={
									<Link
										to={RAIL_CHILD_ROUTE[item.id]}
										aria-current={current ? "page" : undefined}
									/>
								}
							>
								<ItemIcon />
								{item.label}
								<span className="ml-auto flex items-center gap-2 pl-4">
									{item.dot === null ? null : <RailStatusDot dot={item.dot} />}
									<CheckIcon className={current ? undefined : "invisible"} />
								</span>
							</DropdownMenuLinkItem>
						)
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
