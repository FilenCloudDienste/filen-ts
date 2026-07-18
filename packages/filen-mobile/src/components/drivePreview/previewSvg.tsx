import ZoomableView from "@/components/ui/zoomableView"
import View from "@/components/ui/view"
import PreviewLoadingOverlay from "@/components/drivePreview/previewLoadingOverlay"
import { Component, type ReactNode, useMemo, useState } from "react"
import { useWindowDimensions } from "react-native"
import { type SharedValue } from "react-native-reanimated"
import { SvgXml, parse } from "react-native-svg"
import useFileTextQuery from "@/queries/useFileText.query"
import { type GalleryItemTagged } from "@/components/drivePreview/gallery"

// Coarse cap on SVG source length (UTF-16 code units of the decoded document, not exact bytes)
// before we hand it to react-native-svg. Unlike the native androidsvg path this can't take the
// process down — a bad parse is caught JS-side — but a pathologically large document could still
// stall the JS thread while parsing, so oversized input shows the error state instead. ~8M units
// clears any real icon / illustration while rejecting obvious abuse.
const MAX_SVG_SOURCE_LENGTH = 8 * 1024 * 1024

// Guards the rarer failure mode: react-native-svg PARSES fine but throws while reconciling the
// resulting tree into native elements (that throw escapes <SvgXml>, unlike parse errors which it
// swallows — see the parse pre-check below). Contain it here, render nothing, and notify the
// parent to show the "failed" overlay. Keyed with key={xml} at the call site so a recycled cell
// mounts a fresh boundary per source and never inherits a prior item's failure.
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

	const fileTextQuery = useFileTextQuery(
		item.type === "drive"
			? {
					type: "drive",
					data: {
						uuid: item.data.data.uuid,
						// Thread the held item by value so a cross-directory search hit (not in
						// the global uuid cache) still resolves its bytes.
						item: item.data
					}
				}
			: {
					type: "external",
					data: {
						url: item.data.url,
						name: item.data.name
					}
				}
	)

	const xml = fileTextQuery.status === "success" ? fileTextQuery.data : null
	const tooLarge = xml !== null && xml.length > MAX_SVG_SOURCE_LENGTH

	// Stable per-source id for the render boundary's key — cheaper than keying on the (up to
	// multi-MB) document string, and it changes exactly when the previewed item does, so a
	// recycled cell mounts a fresh boundary and never inherits a prior item's failure.
	const itemKey = item.type === "drive" ? item.data.data.uuid : item.data.url

	// <SvgXml> wraps parse() in its OWN try/catch and, on a malformed document, silently returns
	// null (a blank page) instead of throwing — so an error boundary around it never fires for
	// parse errors. Pre-parse here to detect that case and drive the error overlay. parse() is
	// pure, so a document that validates here won't throw inside <SvgXml> below.
	const parseFailed = useMemo(() => {
		if (xml === null || tooLarge) {
			return false
		}

		try {
			// A well-formed but ROOTLESS document (whitespace-, comment-, or XML-declaration-only)
			// parses to null WITHOUT throwing → <SvgXml> would render an empty tree (silent blank).
			// Treat a null root as a failure so it shows the error overlay too; parse() returns
			// non-null for any document that actually has an <svg> root.
			return parse(xml) === null
		} catch {
			return true
		}
	}, [xml, tooLarge])

	// Latched when react-native-svg throws while reconciling this specific (parseable) source.
	// Keyed to the source string so a recycled cell re-attempts its new item.
	const [renderFailedFor, setRenderFailedFor] = useState<string | null>(null)
	const renderFailed = xml !== null && renderFailedFor === xml

	const itemStyle = {
		width: dimensions.width,
		height: dimensions.height
	}

	const status: "loading" | "loaded" | "error" =
		fileTextQuery.status === "error"
			? "error"
			: xml === null
				? "loading"
				: tooLarge || parseFailed || renderFailed
					? "error"
					: "loaded"

	return (
		<View
			className="bg-transparent"
			style={itemStyle}
		>
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
				maxZoom={10}
			>
				{status === "loaded" && xml !== null ? (
					<SvgRenderBoundary
						key={itemKey}
						onError={() => setRenderFailedFor(xml)}
					>
						<SvgXml
							xml={xml}
							width={dimensions.width}
							height={dimensions.height}
							preserveAspectRatio="xMidYMid meet"
						/>
					</SvgRenderBoundary>
				) : null}
			</ZoomableView>
			{status !== "loaded" ? <PreviewLoadingOverlay status={status === "error" ? "error" : "loading"} /> : null}
		</View>
	)
}

export default PreviewSvg
