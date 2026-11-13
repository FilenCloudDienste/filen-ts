import type { ReactNode } from "react"
import { cn } from "@filen/shared"

// The pieces the image and video editors' tool panels share: a labelled section, a chip, an icon-over-name turn
// button, and a filter tile with its thumbnail (the tabs' ids and classes: editPanelTabs.ts). Touch targets grow to
// 44 px under a coarse pointer.

export function Section(props: { label: string; children: ReactNode }) {
	return (
		<div
			role="group"
			aria-label={props.label}
			className="flex flex-col gap-2.5"
		>
			<span className="text-xs font-medium text-muted-foreground">{props.label}</span>
			{props.children}
		</div>
	)
}

export function Chip(props: { selected: boolean; disabled?: boolean | undefined; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={props.selected}
			disabled={props.disabled}
			className={cn(
				"h-7 rounded-full px-3 text-xs font-medium tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50 motion-reduce:transition-none pointer-coarse:h-11",
				props.selected
					? "bg-primary text-primary-foreground"
					: "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
			)}
			onClick={props.onClick}
		>
			{props.children}
		</button>
	)
}

// Rotate and flip: an icon over its name.
export function TurnButton(props: { label: string; icon: ReactNode; disabled?: boolean | undefined; onClick: () => void }) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl bg-muted px-1 py-2.5 text-center text-[11px] leading-tight text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:translate-y-px disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-4.5 [&_svg]:shrink-0"
			onClick={props.onClick}
		>
			{props.icon}
			{props.label}
		</button>
	)
}

// A filter's thumbnail, drawn from its bitmap (owned and closed by the editor).
export function FilterThumbnail(props: { bitmap: ImageBitmap | undefined }) {
	return (
		<canvas
			aria-hidden="true"
			className="block aspect-square w-full bg-muted object-cover"
			ref={canvas => {
				const bitmap = props.bitmap

				// A closed bitmap (replaced while this render was in flight) reads 0 wide.
				if (canvas === null || bitmap === undefined || bitmap.width === 0) {
					return
				}

				canvas.width = bitmap.width
				canvas.height = bitmap.height
				canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
			}}
		/>
	)
}

export function FilterTile(props: {
	label: string
	selected: boolean
	disabled?: boolean | undefined
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-pressed={props.selected}
			disabled={props.disabled}
			className="group/tile flex min-w-0 flex-col items-center gap-1.5 text-xs outline-none disabled:opacity-50"
			onClick={props.onClick}
		>
			<span
				className={cn(
					"block w-full overflow-hidden rounded-xl ring-offset-2 ring-offset-background transition-shadow group-focus-visible/tile:outline-2 group-focus-visible/tile:outline-offset-4 group-focus-visible/tile:outline-ring motion-reduce:transition-none",
					props.selected ? "ring-2 ring-primary" : "ring-1 ring-border group-hover/tile:ring-foreground/40"
				)}
			>
				{props.children}
			</span>
			<span className={cn("w-full truncate text-center", props.selected ? "font-medium text-foreground" : "text-muted-foreground")}>
				{props.label}
			</span>
		</button>
	)
}
