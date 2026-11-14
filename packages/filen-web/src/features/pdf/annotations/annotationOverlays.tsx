import { PdfAnnotationLayer } from "@/features/pdf/annotations/annotationLayer"
import type { PdfToolOverlayProps } from "@/features/pdf/tools/registry"

// Each annotation tool's page overlay: the shared annotation layer in the tool's mode.

export function SelectOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="select"
		/>
	)
}

export function HandOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="hand"
		/>
	)
}

export function TextBoxOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="textBox"
		/>
	)
}

export function DrawOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="draw"
		/>
	)
}

export function MarkupOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="markup"
		/>
	)
}

export function ShapesOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="shape"
		/>
	)
}

export function StampOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="stamp"
		/>
	)
}

export function NoteOverlay(props: PdfToolOverlayProps) {
	return (
		<PdfAnnotationLayer
			{...props}
			mode="note"
		/>
	)
}
