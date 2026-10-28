import { useTranslation } from "react-i18next"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { keepFocus, type DocxSwatch, type DocxSwatchLabel } from "@/features/office/lib/officeControls"
import { i18n } from "@/lib/i18n"

// The office editors' colour picker (the DOCX editor's font colour, highlighter and table shading; the spreadsheet
// toolbar's text and fill colours), in a module that reaches no editor code.

// A swatch's accessible name: its colour, and how much lighter or darker a theme variation is.
function swatchName(label: DocxSwatchLabel): string {
	const name = i18n.t(`preview:${label.name}`)

	if (label.tone === undefined) {
		return name
	}

	return i18n.t(label.tone.lighter ? "preview:previewOfficeColorLighter" : "preview:previewOfficeColorDarker", {
		color: name,
		percent: label.tone.percent
	})
}

export function SwatchButton({ rgb, label, chosen, onPick }: { rgb: string; label: string; chosen: boolean; onPick: () => void }) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={chosen}
			title={label}
			className={cn("size-5 rounded-sm focus-ring ring-1 ring-border", chosen && "ring-2 ring-primary")}
			style={{ backgroundColor: `#${rgb}` }}
			onMouseDown={keepFocus}
			onClick={onPick}
		/>
	)
}

// Word's theme colours and their variations, its standard colours, and the option without one (Automatic or No
// color) when `none` is given. `chosen`: the key of the colour in effect.
export function DocxColorGrid({
	theme,
	standard,
	chosen,
	none,
	onPick
}: {
	theme: readonly (readonly DocxSwatch[])[]
	standard: readonly DocxSwatch[]
	chosen: string | undefined
	none?: { label: string; key: string } | undefined
	onPick: (swatch: DocxSwatch | null) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<div className="flex flex-col gap-2">
			{none === undefined ? null : (
				<Button
					variant="ghost"
					size="sm"
					className={cn("justify-start", chosen === none.key && "bg-accent")}
					onMouseDown={keepFocus}
					onClick={() => {
						onPick(null)
					}}
				>
					{none.label}
				</Button>
			)}
			{theme.length > 0 ? (
				<div
					role="group"
					aria-label={t("previewOfficeColorThemeColors")}
					className="flex flex-col gap-1"
				>
					<p className="text-xs text-muted-foreground">{t("previewOfficeColorThemeColors")}</p>
					{theme.map((row, index) => (
						<div
							key={row[0]?.key ?? index}
							className={cn("grid grid-cols-10 gap-1", index === 1 && "mt-1")}
						>
							{row.map(swatch => (
								<SwatchButton
									key={swatch.key}
									rgb={swatch.rgb}
									label={swatchName(swatch.label)}
									chosen={chosen === swatch.key}
									onPick={() => {
										onPick(swatch)
									}}
								/>
							))}
						</div>
					))}
				</div>
			) : null}
			<div
				role="group"
				aria-label={t("previewOfficeColorStandardColors")}
				className="flex flex-col gap-1"
			>
				<p className="text-xs text-muted-foreground">{t("previewOfficeColorStandardColors")}</p>
				<div className="grid grid-cols-10 gap-1">
					{standard.map(swatch => (
						<SwatchButton
							key={swatch.key}
							rgb={swatch.rgb}
							label={swatchName(swatch.label)}
							chosen={chosen === swatch.key}
							onPick={() => {
								onPick(swatch)
							}}
						/>
					))}
				</div>
			</div>
		</div>
	)
}
