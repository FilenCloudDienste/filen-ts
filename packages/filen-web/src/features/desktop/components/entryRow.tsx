import type { ReactNode } from "react"
import { MiddleEllipsis } from "@/components/middleEllipsis"

// A path row in a SettingsGroup's panel rhythm: the path first, middle-truncated so its file name stays readable,
// what happens to it under it, and its actions beside.
export function EntryRow({ path, detail, children }: { path: string; detail?: ReactNode; children?: ReactNode }) {
	return (
		<div
			data-slot="settings-row"
			className="flex min-h-12 flex-col gap-2 px-5 py-2.5 sm:flex-row sm:items-center sm:gap-4"
		>
			<div
				title={path}
				className="flex min-w-0 flex-1 flex-col gap-0.5"
			>
				<MiddleEllipsis
					value={path}
					className="text-sm font-medium"
				/>
				{detail === undefined ? null : <p className="truncate text-xs text-muted-foreground">{detail}</p>}
			</div>
			{children === undefined ? null : <div className="flex shrink-0 flex-wrap items-center gap-1.5">{children}</div>}
		</div>
	)
}
