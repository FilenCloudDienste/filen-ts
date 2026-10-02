import { Fragment, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { UseQueryResult } from "@tanstack/react-query"
import { ChevronRightIcon } from "lucide-react"
import type { DriveItem } from "@/features/drive/lib/item"
import { asErrorDTO } from "@/lib/sdk/errors"
import { cn, driveItemName } from "@filen/shared"
import { DirectoryGlyph } from "@/features/drive/components/itemIcon"
import { EmptyState } from "@/features/drive/components/emptyState"
import { LoadingState } from "@/components/loadingState"
import { NoResultsMessage } from "@/components/emptyMessage"
import { SURFACE_RING } from "@/components/ui/surface"
import { LIST_DIALOG_BODY_CLASS } from "@/components/dialogs/listDialog"

// Shared UI of the in-dialog drive pickers (move/copy, photos root, chat attach, playlist tracks); their
// state lives in hooks/useDirectoryPicker.ts. Row gating and selection stay per dialog.

export const PICKER_ROW_CLASS =
	"flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm focus-ring-row outline-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"

export interface PickerBreadcrumbProps {
	pathStack: string[]
	names: Record<string, string> | undefined
	onRoot: () => void
	onJump: (index: number) => void
}

export function PickerBreadcrumb({ pathStack, names, onRoot, onJump }: PickerBreadcrumbProps) {
	const { t } = useTranslation("drive")

	return (
		<nav
			aria-label={t("driveBreadcrumbLabel")}
			className="flex items-center gap-1.5 overflow-x-auto text-sm"
		>
			<button
				type="button"
				disabled={pathStack.length === 0}
				onClick={onRoot}
				className={cn(
					"shrink-0",
					pathStack.length === 0 ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:underline"
				)}
			>
				{t("driveMyDrive")}
			</button>
			{pathStack.map((uuid, index) => {
				const isLast = index === pathStack.length - 1

				return (
					<Fragment key={uuid}>
						<ChevronRightIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<button
							type="button"
							disabled={isLast}
							onClick={() => {
								onJump(index)
							}}
							className={cn(
								"min-w-0 shrink-0 truncate",
								isLast ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:underline"
							)}
						>
							{names?.[uuid] ?? uuid}
						</button>
					</Fragment>
				)
			})}
		</nav>
	)
}

export interface PickerListShellProps {
	listingQuery: UseQueryResult<DriveItem[]>
	isEmpty: boolean
	// An active filter matched nothing: show the no-results state instead of the empty-directory one.
	noResults?: boolean
	children: ReactNode
}

export function PickerListShell({ listingQuery, isEmpty, noResults, children }: PickerListShellProps) {
	return (
		<div className={`flex flex-col overflow-y-auto rounded-xl ${SURFACE_RING} ${LIST_DIALOG_BODY_CLASS}`}>
			{listingQuery.status === "pending" ? (
				<LoadingState size="md" />
			) : listingQuery.status === "error" ? (
				<EmptyState
					variant="error"
					error={asErrorDTO(listingQuery.error)}
					onRetry={() => {
						void listingQuery.refetch()
					}}
				/>
			) : isEmpty ? (
				noResults === true ? (
					<NoResultsMessage />
				) : (
					<EmptyState
						variant="empty"
						driveVariant="drive"
					/>
				)
			) : (
				<ul className="flex flex-col gap-0.5 p-2">{children}</ul>
			)}
		</div>
	)
}

export interface PickerDirectoryRowProps {
	directory: Extract<DriveItem, { type: "directory" }>
	disabled: boolean
	onDescend: (uuid: string) => void
}

// Single click only focuses; double-click or Enter descends, leaving the current directory as the pick.
export function PickerDirectoryRow({ directory, disabled, onDescend }: PickerDirectoryRowProps) {
	return (
		<li>
			<button
				type="button"
				disabled={disabled}
				onDoubleClick={() => {
					if (!disabled) {
						onDescend(directory.data.uuid)
					}
				}}
				onKeyDown={event => {
					if (event.key === "Enter" && !disabled) {
						event.preventDefault()
						onDescend(directory.data.uuid)
					}
				}}
				className={PICKER_ROW_CLASS}
			>
				<DirectoryGlyph
					color={directory.data.color}
					className="size-4 shrink-0"
				/>
				<span className="min-w-0 flex-1 truncate">{driveItemName(directory)}</span>
			</button>
		</li>
	)
}
