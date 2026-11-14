import { useId } from "react"
import { useTranslation } from "react-i18next"
import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "@filen/shared"
import { SIGNATURE_INK } from "@/features/pdf/fillSign/signatureRender"
import { isSignatureStyle, SIGNATURE_STYLES, signatureFontFamily, type SignatureStyle } from "@/features/pdf/fillSign/signatureStyles"

// The Type tab's handwriting styles: the typed name drawn in each, one radio per style (arrow keys move between them),
// named by its caption. A preview is drawn with the same font list the placed signature is rendered with.

const STYLE_LABELS = {
	"dancing-script": "previewPdfSignatureStyleFlowing",
	"ms-madi": "previewPdfSignatureStyleQuick",
	"pinyon-script": "previewPdfSignatureStyleFormal"
} as const satisfies Record<SignatureStyle, string>

export function SignatureStylePicker({
	text,
	value,
	onChange
}: {
	text: string
	value: SignatureStyle
	onChange: (style: SignatureStyle) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()

	return (
		<div className="flex flex-col gap-2">
			<span
				id={`${id}-label`}
				className="text-sm font-medium"
			>
				{t("previewPdfSignatureStyle")}
			</span>
			<RadioGroupPrimitive
				aria-labelledby={`${id}-label`}
				value={value}
				onValueChange={(next: unknown) => {
					if (isSignatureStyle(next)) onChange(next)
				}}
				className="flex flex-col gap-2"
			>
				{SIGNATURE_STYLES.map(style => {
					const label = t(STYLE_LABELS[style])

					return (
						<RadioPrimitive.Root
							key={style}
							value={style}
							aria-labelledby={`${id}-${style}`}
							className={cn(
								"flex min-h-16 w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl border bg-white px-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
								style === value ? "border-primary ring-2 ring-primary/40" : "border-input"
							)}
						>
							<span
								aria-hidden
								className="min-w-0 flex-1 truncate py-1 text-4xl leading-normal"
								style={{ fontFamily: signatureFontFamily(style), color: SIGNATURE_INK }}
							>
								{text.trim() === "" ? label : text}
							</span>
							<span
								id={`${id}-${style}`}
								className="shrink-0 text-xs text-neutral-600"
							>
								{label}
							</span>
						</RadioPrimitive.Root>
					)
				})}
			</RadioGroupPrimitive>
		</div>
	)
}
