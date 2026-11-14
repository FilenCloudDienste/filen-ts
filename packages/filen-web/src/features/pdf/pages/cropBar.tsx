import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { CropIcon, ScanIcon } from "lucide-react"
import { cropScopePages, type CropScope } from "@filen/office/core/pdfedit/crop"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

export type CropScopeKind = CropScope["kind"]

export interface PdfCropApply {
	// 0-based pages the crop applies to.
	readonly pages: readonly number[]
	// Also delete what lies outside (the host marks it for redaction: outsideCropRects).
	readonly removeOutside: boolean
}

export interface PdfCropBarProps {
	readonly pageCount: number
	// 0-based.
	readonly current: number
	readonly selected: readonly number[]
	// A crop rect is drawn on the page.
	readonly canApply: boolean
	readonly busy?: boolean
	// "Remove white margins" for the scope's pages: the host crops each to its content (cropPagesToContent).
	readonly onRemoveMargins: (pages: readonly number[]) => void
	readonly onApply: (request: PdfCropApply) => void
	readonly onCancel: () => void
}

const SCOPES: readonly CropScopeKind[] = ["current", "selected", "all", "odd", "even", "range"]

// The crop tool's bar: which pages (this page ▾ / selected / all / odd / even / typed range), Remove white margins,
// the "remove content outside" switch, Apply and Cancel, and the honest note that cropping hides rather than removes.
export function PdfCropBar({ pageCount, current, selected, canApply, busy, onRemoveMargins, onApply, onCancel }: PdfCropBarProps) {
	const { t } = useTranslation("preview")
	const id = useId()
	const [scope, setScope] = useState<CropScopeKind>("current")
	const [range, setRange] = useState("")
	const [removeOutside, setRemoveOutside] = useState(false)
	const kinds = SCOPES.filter(kind => kind !== "selected" || selected.length > 1)
	const pages = cropScopePages(scope === "range" ? { kind: "range", text: range } : { kind: scope }, pageCount, current, selected)
	const rangeInvalid = scope === "range" && range.trim().length > 0 && pages === null
	const working = busy === true
	const label = (kind: CropScopeKind): string => {
		switch (kind) {
			case "current":
				return t("previewPdfCropScopeCurrent")
			case "selected":
				return t("previewPdfCropScopeSelected")
			case "all":
				return t("previewPdfCropScopeAll")
			case "odd":
				return t("previewPdfCropScopeOdd")
			case "even":
				return t("previewPdfCropScopeEven")
			case "range":
				return t("previewPdfCropScopeRange")
		}
	}

	return (
		<div
			role="toolbar"
			aria-label={t("previewPdfCrop")}
			className="flex flex-wrap items-center gap-2 border-b border-border bg-background px-3 py-2"
			data-preview-surface
		>
			<CropIcon
				className="size-4 text-muted-foreground"
				aria-hidden="true"
			/>
			<Label htmlFor={`${id}-scope`}>{t("previewPdfCropScope")}</Label>
			<Select
				items={kinds.map(kind => ({ value: kind, label: label(kind) }))}
				value={scope}
				disabled={working}
				onValueChange={next => {
					const found = kinds.find(kind => kind === next)

					if (found !== undefined) setScope(found)
				}}
			>
				<SelectTrigger
					id={`${id}-scope`}
					className="h-8 min-w-32"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{kinds.map(kind => (
							<SelectItem
								key={kind}
								value={kind}
							>
								{label(kind)}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
			{scope === "range" ? (
				<Input
					aria-label={t("previewPdfCropRangeLabel")}
					aria-invalid={rangeInvalid}
					placeholder={t("previewPdfPageRangePlaceholder")}
					autoComplete="off"
					spellCheck={false}
					className="h-8 w-36 leading-5"
					value={range}
					disabled={working}
					onChange={event => {
						setRange(event.target.value)
					}}
				/>
			) : null}
			<Button
				variant="ghost"
				size="sm"
				disabled={working || pages === null || pages.length === 0}
				onClick={() => {
					if (pages !== null) onRemoveMargins(pages)
				}}
			>
				<ScanIcon aria-hidden="true" />
				{t("previewPdfCropRemoveMargins")}
			</Button>
			<div className="flex items-center gap-2">
				<Switch
					id={`${id}-outside`}
					checked={removeOutside}
					disabled={working}
					onCheckedChange={setRemoveOutside}
				/>
				<Label htmlFor={`${id}-outside`}>{t("previewPdfCropRemoveOutside")}</Label>
			</div>
			<span
				className="text-xs text-muted-foreground"
				title={t("previewPdfCropNotice")}
			>
				{t("previewPdfCropNote")}
			</span>
			<span
				id={`${id}-notice`}
				className="sr-only"
			>
				{t("previewPdfCropNotice")}
			</span>
			<div className="ml-auto flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={working}
					onClick={onCancel}
				>
					{t("previewPdfCropCancel")}
				</Button>
				<Button
					size="sm"
					aria-describedby={`${id}-notice`}
					disabled={working || !canApply || pages === null || pages.length === 0}
					onClick={() => {
						if (pages !== null) onApply({ pages, removeOutside })
					}}
				>
					{t("previewPdfCropApply")}
				</Button>
			</div>
		</div>
	)
}
