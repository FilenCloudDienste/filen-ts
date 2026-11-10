import type { ComponentType, ReactNode } from "react"
import { cn } from "@filen/shared"
import { SettingsBlock } from "@/features/settings/components/settingsLayout"
import { EmptyMessage } from "@/components/emptyMessage"

interface SettingsTableColumn<T> {
	header: string
	// Extra classes for this column's cells.
	className?: string
	cell: (row: T) => ReactNode
}

interface SettingsTableBlockProps<T> {
	rows: readonly T[]
	rowKey: (row: T) => string
	columns: readonly SettingsTableColumn<T>[]
	empty: { icon: ComponentType; title: string; description: string }
}

// Plain semantic <table> markup: no ui/table.tsx primitive exists in the locked registry, and the
// storage breakdown row's precedent is to compose existing primitives rather than add to it.
function SettingsTableBlock<T>({ rows, rowKey, columns, empty }: SettingsTableBlockProps<T>) {
	return (
		<SettingsBlock>
			{rows.length === 0 ? (
				<EmptyMessage
					className="rounded-none border-0 p-4"
					icon={empty.icon}
					title={empty.title}
					description={empty.description}
				/>
			) : (
				// The same bordered surface as a subscription item, so the two blocks read as one family.
				<div className="overflow-x-auto rounded-2xl border border-border/60">
					<table className="w-full text-start text-sm">
						<thead className="bg-muted/40">
							<tr className="text-xs text-muted-foreground">
								{columns.map(column => (
									<th
										key={column.header}
										scope="col"
										className={cn("px-4 py-2.5 font-medium whitespace-nowrap", column.className)}
									>
										{column.header}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map(row => (
								<tr
									key={rowKey(row)}
									className="border-t border-border/60"
								>
									{columns.map(column => (
										<td
											key={column.header}
											className={cn("px-4 py-2.5", column.className)}
										>
											{column.cell(row)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</SettingsBlock>
	)
}

export { SettingsTableBlock }
