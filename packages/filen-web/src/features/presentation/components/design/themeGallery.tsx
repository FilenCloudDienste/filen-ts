import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PaletteIcon } from "lucide-react"
import { deckThemeOp, galleryThemeOp, variantOp, type DesignThemeInfo, type SlideRef } from "@filen/office/core/presentation"
import { FILEN_THEMES, filenTheme } from "@filen/office/core/templates"
import { cn } from "@filen/shared"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { keepFocus } from "@/features/office/lib/officeControls"
import { useCommandMenuFocus } from "@/features/preview/components/docxInsert.logic"
import { THEME_NAME_KEYS, deckThemePreview, galleryPreview } from "@/features/presentation/components/design/design.logic"
import { designState } from "@/features/presentation/components/design/designState"
import { ThemeSwatch } from "@/features/presentation/components/design/themeSwatch"
import { usePresentationEditor, type PresentationEditor } from "@/features/presentation/hooks/usePresentationSession"

// The Design tab's Themes gallery (the presentation's own themes, then Filen's eight) and Variants (the four colour
// variants of the current slide's Filen theme). A theme applies to every slide, or to the slides selected in the
// slide list; a variant to every slide on the current slide's master.

function ThemeName({ info, index }: { info: DesignThemeInfo; index: number }) {
	const { t } = useTranslation("preview")
	const ours = info.gallery === undefined ? undefined : THEME_NAME_KEYS[info.gallery.id]

	if (ours !== undefined && info.gallery !== undefined)
		return <>{t("previewPptxDesignThemeVariantName", { name: t(ours), n: info.gallery.variant + 1 })}</>

	return <>{info.name ?? t("previewPptxDesignThemeUntitled", { n: index + 1 })}</>
}

export function ThemesControl() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const editor = scope?.editor
	const focus = useCommandMenuFocus()
	const [selectedOnly, setSelectedOnly] = useState(false)
	const { design, current } = designState(editor)
	const disabled = editor === undefined || !editor.editable || editor.document.slides.length === 0
	const targets = (): readonly SlideRef[] =>
		editor === undefined ? [] : selectedOnly ? editor.selection : editor.document.slides.map(slide => slide.ref)
	const run = (op: Parameters<PresentationEditor["command"]>[0]): void => {
		focus.ran()
		void editor?.command(op)
	}

	return (
		<DropdownMenu onOpenChange={focus.opened}>
			<RibbonMenuTrigger
				label={t("previewPptxDesignThemes")}
				text={t("previewPptxDesignThemes")}
				icon={<PaletteIcon />}
				disabled={disabled}
			/>
			<DropdownMenuContent
				finalFocus={focus.finalFocus}
				data-preview-surface
				className="w-[min(22rem,calc(100vw-2rem))]"
			>
				{design.themes.length === 0 ? null : (
					<DropdownMenuGroup>
						<DropdownMenuLabel>{t("previewPptxDesignThisPresentation")}</DropdownMenuLabel>
						{design.themes.map((info, index) => (
							<DropdownMenuItem
								key={info.key}
								className={cn("gap-3", info.master === current?.master && "bg-accent/60")}
								onClick={() => {
									run(deckThemeOp(info, targets()))
								}}
							>
								<ThemeSwatch
									id={`deck-${String(index)}`}
									preview={deckThemePreview(info, filenTheme)}
									width={48}
								/>
								<span className="min-w-0 truncate">
									<ThemeName
										info={info}
										index={index}
									/>
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				)}
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewPptxDesignFilenThemes")}</DropdownMenuLabel>
					<div className="grid grid-cols-2 gap-1 p-1 sm:grid-cols-4">
						{FILEN_THEMES.map(theme => {
							const name = t(THEME_NAME_KEYS[theme.id] ?? "previewPptxDesignTheme_filen")

							return (
								<DropdownMenuItem
									key={theme.id}
									aria-label={name}
									className="flex-col items-center gap-1 px-1 py-1.5"
									onClick={() => {
										run(galleryThemeOp(theme.id, 0, targets()))
									}}
								>
									<ThemeSwatch
										id={`gallery-${theme.id}`}
										preview={galleryPreview(theme, 0)}
									/>
									<span className="text-xs">{name}</span>
								</DropdownMenuItem>
							)
						})}
					</div>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuCheckboxItem
					checked={selectedOnly}
					closeOnClick={false}
					onCheckedChange={checked => {
						setSelectedOnly(checked)
					}}
				>
					{t("previewPptxDesignApplySelected")}
				</DropdownMenuCheckboxItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The four variants of the current slide's Filen theme, as swatch buttons.
export function VariantsControl() {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const editor = scope?.editor
	const { master, current } = designState(editor)
	const theme = current?.gallery === undefined ? undefined : filenTheme(current.gallery.id)
	const disabled = editor === undefined || !editor.editable || master === undefined || theme === undefined
	const shown = theme ?? FILEN_THEMES[0]

	if (shown === undefined) return null

	return (
		<div className="flex items-center gap-1">
			{shown.variants.map((_, variant) => {
				const label =
					disabled && theme === undefined
						? t("previewPptxDesignVariantsUnavailable")
						: t("previewPptxDesignVariant", { n: variant + 1 })
				const chosen = current?.gallery?.variant === variant && theme !== undefined

				return (
					<Tooltip key={variant}>
						<TooltipTrigger
							render={
								<Button
									variant="ghost"
									aria-label={t("previewPptxDesignVariant", { n: variant + 1 })}
									aria-pressed={chosen}
									disabled={disabled}
									// aria-disabled rather than disabled: why the variants are off must stay reachable by hover.
									focusableWhenDisabled
									className={cn(
										"h-auto rounded-[4px] p-0.5 aria-disabled:opacity-50",
										chosen ? "ring-2 ring-primary" : "hover:bg-accent"
									)}
									onMouseDown={keepFocus}
									onClick={() => {
										if (!disabled && !chosen) void editor.command(variantOp(master, variant))
									}}
								>
									<ThemeSwatch
										id={`variant-${String(variant)}`}
										preview={galleryPreview(shown, variant)}
										width={40}
									/>
								</Button>
							}
						/>
						<TooltipContent>{label}</TooltipContent>
					</Tooltip>
				)
			})}
		</div>
	)
}
