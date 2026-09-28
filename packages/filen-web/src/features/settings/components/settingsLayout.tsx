import type { ComponentProps, ComponentType, ReactNode } from "react"
import { ArrowUpRightIcon } from "lucide-react"
import { cn } from "@filen/shared"

type IconType = ComponentType<{ className?: string }>

interface SettingsPageHeaderProps {
	icon: IconType
	title: string
}

// The section's h1 is what e2e and the settings route barrier (e2e/helpers/settings.ts) wait on, so
// its accessible name is the plain section title and nothing else.
function SettingsPageHeader({ icon: Icon, title }: SettingsPageHeaderProps) {
	return (
		<header className="flex h-14 shrink-0 items-center gap-3 px-4">
			<div className="flex items-center gap-2">
				<Icon className="size-4 text-muted-foreground" />
				<h1 className="font-heading text-base font-medium tracking-tight">{title}</h1>
			</div>
		</header>
	)
}

interface SettingsPageProps extends SettingsPageHeaderProps {
	children: ReactNode
}

// Header plus the one scroll container. The column is flex-1 so a page-level loading or error state
// centers in the viewport instead of hugging the top.
function SettingsPage({ icon, title, children }: SettingsPageProps) {
	return (
		<>
			<SettingsPageHeader
				icon={icon}
				title={title}
			/>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-2 pb-12 sm:px-6">
				<div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8">{children}</div>
			</div>
		</>
	)
}

// Same radius, ring and shadow as ui/card.tsx, so a settings page reads as the same surface family.
function SettingsPanel({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="settings-panel"
			className={cn(
				"overflow-hidden rounded-[min(var(--radius-4xl),24px)] bg-card text-sm text-card-foreground shadow-sm ring-1 ring-foreground/5 dark:ring-foreground/10",
				className
			)}
			{...props}
		/>
	)
}

interface SettingsGroupProps {
	title?: string
	description?: ReactNode
	variant?: "default" | "danger"
	children: ReactNode
}

// A titled run of rows in one panel. Every child must render as a row (or nothing): the hairline
// dividers are drawn between the panel's direct children, so a stray sibling (a hidden input, a
// wrapper div) would draw a divider of its own.
// No destructuring defaults in these primitives: the React Compiler bails on a component whose props
// pattern carries one.
function SettingsGroup({ title, description, variant, children }: SettingsGroupProps) {
	return (
		<section
			data-slot="settings-group"
			className="flex flex-col gap-2"
		>
			{title !== undefined || description !== undefined ? (
				<div className="flex flex-col gap-1 px-5">
					{title !== undefined && (
						<h2
							className={cn(
								"text-xs font-medium tracking-wider uppercase",
								variant === "danger" ? "text-destructive" : "text-muted-foreground"
							)}
						>
							{title}
						</h2>
					)}
					{description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
				</div>
			) : null}
			<SettingsPanel
				className={cn("divide-y divide-border/60", variant === "danger" && "ring-destructive/20 dark:ring-destructive/30")}
			>
				{children}
			</SettingsPanel>
		</section>
	)
}

interface SettingsRowProps {
	label: string
	description?: ReactNode
	// Renders the label as a <label> for the control with this id — for controls with no visible name
	// of their own (an input, a select trigger).
	htmlFor?: string
	destructive?: boolean
	// Control slot under the text at every width, full width — for wide content (a bar, a table, an
	// input with its button) rather than a single trailing control.
	stacked?: boolean
	children?: ReactNode
}

// Label and description on the left, the control on the right; below `sm` the control drops under
// the text.
function SettingsRow({ label, description, htmlFor, destructive, stacked, children }: SettingsRowProps) {
	const labelClassName = cn("text-sm font-medium", destructive === true && "text-destructive")

	return (
		<div
			data-slot="settings-row"
			className={cn(
				"flex min-h-14 flex-col gap-3 px-5 py-3.5",
				stacked !== true && "sm:flex-row sm:items-center sm:justify-between sm:gap-6"
			)}
		>
			<div className="flex min-w-0 flex-col gap-0.5">
				{htmlFor === undefined ? (
					<p className={labelClassName}>{label}</p>
				) : (
					<label
						htmlFor={htmlFor}
						className={labelClassName}
					>
						{label}
					</label>
				)}
				{description !== undefined && <p className="text-sm break-words text-muted-foreground">{description}</p>}
			</div>
			{children !== undefined && (
				<div className={cn("flex items-center gap-2", stacked === true ? "w-full flex-col items-stretch" : "shrink-0 flex-wrap")}>
					{children}
				</div>
			)}
		</div>
	)
}

// Free-form content that still sits in the panel's row rhythm (a log viewer, an empty state, a table).
function SettingsBlock({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="settings-row"
			className={cn("px-5 py-4", className)}
			{...props}
		/>
	)
}

interface SettingsLinkRowProps {
	href: string
	label: string
}

// A whole row that opens an external page. The arrow is decorative, so the link's accessible name is
// exactly its label.
function SettingsLinkRow({ href, label }: SettingsLinkRowProps) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			data-slot="settings-row"
			className="flex min-h-12 items-center justify-between gap-4 px-5 py-3.5 text-sm font-medium transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
		>
			<span className="min-w-0 truncate">{label}</span>
			<ArrowUpRightIcon
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground"
			/>
		</a>
	)
}

export { SettingsPage, SettingsPageHeader, SettingsPanel, SettingsGroup, SettingsRow, SettingsBlock, SettingsLinkRow }
