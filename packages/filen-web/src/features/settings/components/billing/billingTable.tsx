import type { ComponentType, ReactNode } from "react"
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
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="text-xs text-muted-foreground">
								{columns.map(column => (
									<th
										key={column.header}
										className="pb-2 font-medium"
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
											className={column.className === undefined ? "py-2" : `py-2 ${column.className}`}
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
