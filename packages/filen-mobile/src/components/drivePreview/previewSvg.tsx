import ZoomableView from "@/components/ui/zoomableView"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"
import { Component, type ReactNode, useMemo, useState } from "react"
import { useWindowDimensions } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import { SvgAst, parse, type JsxAST } from "react-native-svg"
import useFileTextQuery from "@/queries/useFileText.query"
import { type GalleryItemTagged, galleryItemKey } from "@/components/drivePreview/gallery"
import { galleryItemFileSource } from "@/components/drivePreview/galleryRenderName"
import UnavailableOfflineNotice from "@/components/drivePreview/unavailableOfflineNotice"
import { isUnavailableOffline } from "@/components/drivePreview/previewAvailability"
import useIsOnline from "@/hooks/useIsOnline"

// Coarse cap on SVG source length (UTF-16 code units of the decoded document, not exact bytes)
// before we hand it to react-native-svg. Unlike the native androidsvg path this can't take the
// process down — a bad parse is caught JS-side — but a pathologically large document could still
// stall the JS thread while parsing, so oversized input shows the error state instead. ~8M units
// clears any real icon / illustration while rejecting obvious abuse.
const MAX_SVG_SOURCE_LENGTH = 8 * 1024 * 1024

// Guards the rarer failure mode: react-native-svg PARSES fine but throws while reconciling the
// resulting tree into native elements (parse errors are caught by the parse below, reconcile errors
// are not). Contain it here, render nothing, and notify the parent to show the "failed" overlay.
// Keyed with key={xml} at the call site so a recycled cell mounts a fresh boundary per source and
// never inherits a prior item's failure.
class SvgRenderBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
	override state = { failed: false }

	static getDerivedStateFromError() {
		return { failed: true }
	}

	override componentDidCatch() {
		this.props.onError()
	}

	override render() {
		return this.state.failed ? null : this.props.children
	}
}

const PreviewSvg = ({
	item,
	zoomScale,
	onPinchDismiss,
	onZoomChange,
	onSingleTap,
	onPinchActiveChange
}: {
	item: GalleryItemTagged
	zoomScale: SharedValue<number>
	onPinchDismiss: () => void
	onZoomChange?: (zoom: number) => void
	onSingleTap?: () => void
	onPinchActiveChange?: (active: boolean) => void
}) => {
	const dimensions = useWindowDimensions()
	const isOnline = useIsOnline()

	const fileTextQuery = useFileTextQuery(galleryItemFileSource(item))

	const xml = fileTextQuery.status === "success" ? fileTextQuery.data : null
	const tooLarge = xml !== null && xml.length > MAX_SVG_SOURCE_LENGTH

	// Stable per-source id for the render boundary's key — cheaper than keying on the (up to
	// multi-MB) document string, and it changes exactly when the previewed item does, so a
	// recycled cell mounts a fresh boundary and never inherits a prior item's failure.
	const itemKey = galleryItemKey(item)

	// Parsed once here and rendered via <SvgAst>; <SvgXml> would parse the document a second time
	// and swallow parse errors into a blank page instead of driving the error overlay.
	const parsed = useMemo((): { ast: JsxAST | null; failed: boolean } => {
		if (xml === null || tooLarge) {
			return { ast: null, failed: false }
		}

		try {
			// A well-formed but ROOTLESS document (whitespace-, comment-, or XML-declaration-only)
			// parses to null WITHOUT throwing, which would render an empty tree (silent blank).
			// Treat a null root as a failure so it shows the error overlay too; parse() returns
			// non-null for any document that actually has an <svg> root.
			const ast = parse(xml)

			return { ast, failed: ast === null }
		} catch {
			return { ast: null, failed: true }
		}
	}, [xml, tooLarge])

	const parseFailed = parsed.failed

	// Latched when react-native-svg throws while reconciling this specific (parseable) source.
	// Keyed to the source string so a recycled cell re-attempts its new item.
	const [renderFailedFor, setRenderFailedFor] = useState<string | null>(null)
	const renderFailed = xml !== null && renderFailedFor === xml

	const itemStyle = {
		width: dimensions.width,
		height: dimensions.height
	}

	if (isUnavailableOffline(fileTextQuery, isOnline)) {
		return <UnavailableOfflineNotice />
	}

	const status: "loading" | "loaded" | "error" =
		fileTextQuery.status === "error"
			? "error"
			: xml === null
				? "loading"
				: tooLarge || parseFailed || renderFailed
					? "error"
					: "loaded"

	// Renders straight into galleryItem's window-sized cell, which the overlay's absolute inset-0 resolves against.
	return (
		<>
			<ZoomableView
				style={[
					{
						flex: 1,
						alignItems: "center",
						justifyContent: "center"
					},
					itemStyle
				]}
				scaleValue={zoomScale}
				onPinchDismiss={onPinchDismiss}
				onZoomChange={onZoomChange}
				onSingleTap={onSingleTap}
				onPinchActiveChange={onPinchActiveChange}
				contentSize={itemStyle}
			>
				{status === "loaded" && xml !== null ? (
					<SvgRenderBoundary
						key={itemKey}
						onError={() => setRenderFailedFor(xml)}
					>
						<SvgAst
							ast={parsed.ast}
							override={{
								width: dimensions.width,
								height: dimensions.height,
								preserveAspectRatio: "xMidYMid meet"
							}}
						/>
					</SvgRenderBoundary>
				) : null}
			</ZoomableView>
			{status !== "loaded" ? <PreviewLoadingOverlay status={status === "error" ? "error" : "loading"} /> : null}
		</>
	)
}

export default PreviewSvg
