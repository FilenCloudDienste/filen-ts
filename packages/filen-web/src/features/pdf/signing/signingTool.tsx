import { useEffect, useEffectEvent, useState, type KeyboardEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"
import type { PdfSignFieldArgs } from "@filen/office/dom/pdfedit"
import { placementPosition, useKeyboardPlacement, type PlacementRect } from "@filen/office/react/pdfedit"
import { CertificateSigningDialog } from "@/features/pdf/signing/certificateSigningDialog"
import { signatureStampLines, signerDisplayName, type PdfCertificateSigning } from "@/features/pdf/signing/signing.logic"
import { SignatureDialog } from "@/features/pdf/fillSign/signatureDialog"
import { loadSavedSignatures, savedVisualSignature, useSavedSignatures } from "@/features/pdf/fillSign/savedSignatures"
import { displayToSurface, surfaceToDisplay } from "@/features/pdf/textEdit/textEdit.logic"
import { withPdfSession, type PdfToolContext, type PdfToolOverlayProps, type PdfToolPanelProps } from "@/features/pdf/tools/registry"
import { pdfToolState, usePdfToolState } from "@/features/pdf/tools/toolState"
import { formatShortDate } from "@/lib/formatDate"
import { log } from "@/lib/log"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Protect › Sign with certificate (S): the certificate dialog (the .p12/.pfx file, its password, the signer, reason,
// location, appearance, certification while the document is unsigned), then the signature is placed: dragged on a
// page, put down with the keyboard (Enter on the page, arrows, Alt+arrows, Enter), or an empty signature field of the
// form chosen. The placed signature is signed as the last step of a save (signing/signDocument.ts); the signer worker,
// holding the key, is terminated once the signature is made or the signing is cancelled. "My signature" shows the
// visual signature saved in Fill & Sign (the newest), or one drawn for this signing.

// A signature's default size in points (a click, or the keyboard).
const DEFAULT_WIDTH = 200
const DEFAULT_HEIGHT = 60
// A drag shorter than this (CSS px) is a click.
const DRAG_MIN = 6
// Pen colour of a drawn visual signature (as Fill & Sign draws it) and its line width per unit of the drawing.
const INK: readonly [number, number, number] = [0.05, 0.1, 0.35]
const LINE_WIDTH = 0.012

type SignPhase =
	| { readonly kind: "dialog" }
	// The visual signature is drawn first ("My signature" without a saved one).
	| { readonly kind: "drawing"; readonly signing: PdfCertificateSigning }
	| { readonly kind: "placing"; readonly signing: PdfCertificateSigning; readonly visual: PdfVisualSignature | null }
	| { readonly kind: "signing" }

const phaseState = pdfToolState<SignPhase>({ kind: "dialog" })

interface StampWords {
	readonly signedBy: (name: string) => string
	readonly date: (date: string) => string
	readonly reason: (reason: string) => string
}

function visualInput(visual: PdfVisualSignature): PdfSignFieldArgs["visual"] {
	if (visual.kind === "image") return { kind: "image", png: visual.png }

	const strokes = visual.strokes.map(stroke => {
		const points: [number, number][] = []

		for (let index = 0; index + 1 < stroke.length; index += 2) points.push([stroke[index] ?? 0, stroke[index + 1] ?? 0])

		return points
	})

	return {
		kind: "strokes",
		width: visual.width,
		height: visual.height,
		strokes,
		lineWidth: Math.max(visual.width, visual.height) * LINE_WIDTH,
		color: INK
	}
}

// Signs at `placement` and ends the tool: the signer is terminated by the signing whatever happens.
function sign(
	context: PdfToolContext,
	placing: Extract<SignPhase, { kind: "placing" }>,
	placement: PdfSignFieldArgs["placement"],
	words: StampWords,
	done: string
): void {
	const { signing, visual } = placing
	const { summary, options } = signing

	phaseState.set({ kind: "signing" })
	void context
		.sign({
			signer: signing.signer,
			summary,
			field: {
				placement,
				visual: options.appearance === "visual" && visual !== null ? visualInput(visual) : null,
				lines: signatureStampLines(summary, options, formatShortDate(Date.now()), words),
				name: signerDisplayName(summary.signer),
				reason: options.reason,
				location: options.location,
				certify: options.certify
			}
		})
		.then(signed => {
			if (signed) toast.success(done)

			context.finish()
		})
}

function useStampWords(): StampWords {
	const { t } = useTranslation("preview")

	return {
		signedBy: name => t("previewPdfSigningStampSignedBy", { name }),
		date: date => t("previewPdfSigningStampDate", { date }),
		reason: reason => t("previewPdfSigningStampReason", { reason })
	}
}

export function SignPanel({ context }: PdfToolPanelProps) {
	const { t } = useTranslation("preview")
	const phase = usePdfToolState(phaseState)
	const saved = useSavedSignatures()
	const [canCertify, setCanCertify] = useState<boolean | null>(null)

	const start = useEffectEvent(() => {
		phaseState.set({ kind: "dialog" })
		loadSavedSignatures().catch((error: unknown) => {
			log.warn("pdf", "saved signatures not loaded", { error })
		})
		// The editor has the document from here (signing changes it); only an unsigned document may be certified.
		withPdfSession(context, session => Promise.resolve(session.getSnapshot().state.signatures.fields.length === 0)).then(
			setCanCertify,
			(error: unknown) => {
				log.warn("pdf", "the editor did not open for signing", { error })
				context.finish()
			}
		)
	})
	const end = useEffectEvent(() => {
		const current = phaseState.get()

		// Cancelled before signing: the key goes now.
		if (current.kind === "drawing" || current.kind === "placing") current.signing.signer.terminate()

		phaseState.set({ kind: "dialog" })
	})

	useEffect(() => {
		start()

		return () => {
			end()
		}
	}, [])

	if (canCertify === null) return null

	switch (phase.kind) {
		case "dialog":
			return (
				<CertificateSigningDialog
					canCertify={canCertify}
					hasVisual
					onPlace={signing => {
						const newest = saved.signatures[0]

						if (signing.options.appearance !== "visual") phaseState.set({ kind: "placing", signing, visual: null })
						else if (newest === undefined) phaseState.set({ kind: "drawing", signing })
						else phaseState.set({ kind: "placing", signing, visual: savedVisualSignature(newest) })
					}}
					onClose={() => {
						context.finish()
					}}
				/>
			)
		case "drawing":
			return (
				<SignatureDialog
					open
					role="signature"
					onOpenChange={open => {
						if (!open) context.finish()
					}}
					onPlace={visual => {
						phaseState.set({ kind: "placing", signing: phase.signing, visual })
					}}
				/>
			)
		case "placing":
			return (
				<div
					role="status"
					className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
				>
					<p className="min-w-0 flex-1">{t("previewPdfSigningPlaceHint")}</p>
					<Button
						variant="outline"
						size="xs"
						onClick={() => {
							context.finish()
						}}
					>
						{t("previewPdfSigningPlaceCancel")}
					</Button>
				</div>
			)
		case "signing":
			return (
				<div
					role="status"
					className="flex shrink-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
				>
					<Spinner
						aria-hidden="true"
						className="size-3.5 shrink-0"
					/>
					<p className="min-w-0 flex-1">{t("previewPdfSigningSaving")}</p>
				</div>
			)
	}
}

// A rectangle of the page box (CSS px, two corners) as the engine's display space [x0, y0, x1, y1].
function displayRect(viewport: PdfToolOverlayProps["viewport"], a: readonly [number, number], b: readonly [number, number]) {
	const [ax, ay] = surfaceToDisplay(viewport, a[0], a[1])
	const [bx, by] = surfaceToDisplay(viewport, b[0], b[1])

	return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] as const
}

// The display rectangle's box on the page (CSS px).
function surfaceBox(viewport: PdfToolOverlayProps["viewport"], rect: readonly [number, number, number, number]) {
	const [ax, ay] = displayToSurface(viewport, rect[0], rect[1])
	const [bx, by] = displayToSurface(viewport, rect[2], rect[3])

	return { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
}

export function SignOverlay({ context, page, viewport, widgets, editing }: PdfToolOverlayProps) {
	const { t } = useTranslation("preview")
	const phase = usePdfToolState(phaseState)
	const words = useStampWords()
	const [drag, setDrag] = useState<{ readonly from: readonly [number, number]; readonly to: readonly [number, number] } | null>(null)
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = viewport.viewBox
	const size = { width: x1 - x0, height: y1 - y0 }
	const done = t("previewPdfSigningSigned")
	const placing = phase.kind === "placing" && editing ? phase : null

	const placeAt = (rect: readonly [number, number, number, number]): void => {
		if (placing !== null) sign(context, placing, { kind: "rect", page, rect: [rect[0], rect[1], rect[2], rect[3]] }, words, done)
	}
	const keyboard = useKeyboardPlacement({
		page: size,
		size: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
		// Bottom-left user space, as the keyboard places: the display rectangle is its mirror.
		onCommit: (rect: PlacementRect) => {
			placeAt([rect.x, size.height - rect.y - rect.height, rect.x + rect.width, size.height - rect.y])
		}
	})

	if (placing === null) return null

	const point = (event: PointerEvent<HTMLDivElement>): [number, number] => {
		const box = event.currentTarget.getBoundingClientRect()

		return [event.clientX - box.left, event.clientY - box.top]
	}

	const emptyFields = (widgets ?? []).filter(widget => widget.type === "signature" && widget.value === "" && !widget.readOnly)
	const indicator =
		drag !== null
			? surfaceBox(viewport, displayRect(viewport, drag.from, drag.to))
			: keyboard.rect === null
				? null
				: surfaceBox(viewport, [
						keyboard.rect.x,
						size.height - keyboard.rect.y - keyboard.rect.height,
						keyboard.rect.x + keyboard.rect.width,
						size.height - keyboard.rect.y
					])
	const position = keyboard.rect === null ? null : placementPosition(keyboard.rect, size)

	return (
		<div
			data-slot="pdf-sign-placement"
			role="application"
			aria-label={t("previewPdfSigningPlaceOnPage", { page: page + 1 })}
			tabIndex={0}
			className="pointer-events-auto absolute inset-0 cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-primary"
			onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
				if (keyboard.rect === null && event.key === "Enter" && event.target === event.currentTarget) {
					event.preventDefault()
					keyboard.start()
				} else keyboard.onKeyDown(event)
			}}
			onPointerDown={event => {
				if (event.button !== 0 || event.target !== event.currentTarget) return

				event.currentTarget.setPointerCapture(event.pointerId)
				setDrag({ from: point(event), to: point(event) })
			}}
			onPointerMove={event => {
				if (drag !== null) setDrag({ from: drag.from, to: point(event) })
			}}
			onPointerUp={event => {
				if (drag === null) return

				const to = point(event)

				setDrag(null)

				if (Math.abs(to[0] - drag.from[0]) < DRAG_MIN || Math.abs(to[1] - drag.from[1]) < DRAG_MIN) {
					// A click: the default size, centred where it was.
					const [cx, cy] = surfaceToDisplay(viewport, to[0], to[1])
					const left = Math.min(Math.max(0, cx - DEFAULT_WIDTH / 2), Math.max(0, size.width - DEFAULT_WIDTH))
					const top = Math.min(Math.max(0, cy - DEFAULT_HEIGHT / 2), Math.max(0, size.height - DEFAULT_HEIGHT))

					placeAt([left, top, left + DEFAULT_WIDTH, top + DEFAULT_HEIGHT])
				} else placeAt(displayRect(viewport, drag.from, to))
			}}
			onPointerCancel={() => {
				setDrag(null)
			}}
		>
			{emptyFields.map(widget => {
				const box = surfaceBox(viewport, [
					widget.rect[0],
					size.height - widget.rect[3],
					widget.rect[2],
					size.height - widget.rect[1]
				])

				return (
					<Button
						key={widget.id}
						variant="outline"
						size="xs"
						className="absolute border-dashed border-primary bg-background/80"
						style={box}
						onPointerDown={event => {
							event.stopPropagation()
						}}
						onClick={() => {
							sign(context, placing, { kind: "field", name: widget.field }, words, done)
						}}
					>
						{t("previewPdfSigningSignHere")}
					</Button>
				)
			})}
			{indicator === null ? null : (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute rounded-xs border-2 border-dashed border-primary bg-primary/10"
					style={indicator}
				/>
			)}
			{position === null ? null : (
				<p
					aria-live="polite"
					className="sr-only"
				>
					{t("previewPdfPlacementPosition", position)}
				</p>
			)}
		</div>
	)
}
