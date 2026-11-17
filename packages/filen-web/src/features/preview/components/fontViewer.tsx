import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { FontAxis, FontInfo } from "@filen/office/core/fonts"
import { driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { PreviewKey } from "@/lib/i18n"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePreviewBytes } from "@/features/preview/hooks/usePreviewBytes"
import { inspectFont } from "@/features/preview/lib/fontInspect"
import { MetadataCard } from "@/features/preview/components/metadataCard"
import { PreviewErrorState, PreviewGate, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { GlyphGrid } from "@/features/preview/components/fontGlyphGrid"
import type { MetadataSectionData } from "@/features/preview/lib/metadataCard.types"
import {
	SPECIMEN_SIZES,
	adjustableAxes,
	axisStep,
	defaultSample,
	displayableRuns,
	fontEmbedding,
	fontFormat,
	formatCount,
	glyphIndex,
	variationSettings,
	type FontEmbedding,
	type FontFormat,
	type GlyphIndex
} from "@/features/preview/components/fontViewer.logic"

type FaceState = { status: "loading" } | { status: "loaded" } | { status: "failed" }

type InfoState = { status: "pending" } | { status: "ready"; info: FontInfo; glyphs: GlyphIndex } | { status: "failed" }

type FontTab = "specimen" | "glyphs" | "info"

const FORMAT_KEYS: Readonly<Record<FontFormat, PreviewKey>> = {
	trueType: "previewFontFormatTrueType",
	openType: "previewFontFormatOpenType",
	openType2: "previewFontFormatOpenType2",
	bitmap: "previewFontFormatBitmap",
	woff: "previewFontFormatWoff",
	woff2: "previewFontFormatWoff2"
}

const OUTLINE_KEYS: Readonly<Record<FontInfo["outlines"], PreviewKey>> = {
	trueType: "previewFontOutlinesTrueType",
	cff: "previewFontOutlinesCff",
	cff2: "previewFontOutlinesCff2",
	bitmap: "previewFontOutlinesBitmap"
}

const EMBEDDING_KEYS: Readonly<Record<FontEmbedding, PreviewKey>> = {
	installable: "previewFontEmbeddingInstallable",
	restricted: "previewFontEmbeddingRestricted",
	previewPrint: "previewFontEmbeddingPreviewPrint",
	editable: "previewFontEmbeddingEditable"
}

// The name labels by name ID (fontInfo's FONT_INFO_NAME_IDS).
const NAME_KEYS: Readonly<Record<number, PreviewKey>> = {
	0: "previewFontName0",
	1: "previewFontName1",
	2: "previewFontName2",
	3: "previewFontName3",
	4: "previewFontName4",
	5: "previewFontName5",
	6: "previewFontName6",
	7: "previewFontName7",
	8: "previewFontName8",
	9: "previewFontName9",
	10: "previewFontName10",
	11: "previewFontName11",
	12: "previewFontName12",
	13: "previewFontName13",
	14: "previewFontName14",
	16: "previewFontName16",
	17: "previewFontName17",
	19: "previewFontName19"
}

function isFontTab(value: unknown): value is FontTab {
	return value === "specimen" || value === "glyphs" || value === "info"
}

// The file's bytes registered as a font face of a family no app style uses, removed again on unmount.
function useFontFace(bytes: Uint8Array, family: string): FaceState {
	const [state, setState] = useState<FaceState>({ status: "loading" })

	useEffect(() => {
		let live = true
		// The cache's bytes are never shared memory.
		const face = new FontFace(family, bytes as Uint8Array<ArrayBuffer>)

		document.fonts.add(face)
		face.load().then(
			() => {
				if (live) setState({ status: "loaded" })
			},
			() => {
				if (live) setState({ status: "failed" })
			}
		)

		return () => {
			live = false
			document.fonts.delete(face)
		}
	}, [bytes, family])

	return state
}

// The font's info, read in its worker (fontInspect.ts).
function useFontInfo(bytes: Uint8Array): InfoState {
	const [state, setState] = useState<InfoState>({ status: "pending" })

	useEffect(() => {
		let live = true

		inspectFont(bytes).then(
			info => {
				if (live) setState({ status: "ready", info, glyphs: glyphIndex(displayableRuns(info.codePoints)) })
			},
			() => {
				if (live) setState({ status: "failed" })
			}
		)

		return () => {
			live = false
		}
	}, [bytes])

	return state
}

function nameOf(info: FontInfo, id: number): string | undefined {
	return info.names.find(name => name.id === id)?.value
}

function AxisSlider({ axis, value, onChange }: { axis: FontAxis; value: number; onChange: (value: number) => void }) {
	const labelId = useId()

	return (
		<div className="flex items-center gap-3 text-sm">
			<span
				id={labelId}
				className="w-28 shrink-0 truncate text-muted-foreground"
			>
				{axis.name ?? axis.tag}
			</span>
			<Slider
				aria-labelledby={labelId}
				min={axis.min}
				max={axis.max}
				step={axisStep(axis)}
				value={value}
				className="max-w-72 flex-1"
				onValueChange={next => {
					const moved = typeof next === "number" ? next : next[0]

					if (moved !== undefined) onChange(moved)
				}}
			/>
			<span className="w-14 shrink-0 text-end tabular-nums">{Math.round(value * 100) / 100}</span>
		</div>
	)
}

function Specimen({
	family,
	text,
	axes,
	settings,
	onAxis
}: {
	family: string
	text: string
	axes: readonly FontAxis[]
	settings: ReadonlyMap<string, number>
	onAxis: (tag: string, value: number) => void
}) {
	const { t } = useTranslation("preview")
	const style: CSSProperties = { fontFamily: `"${family}"`, fontVariationSettings: variationSettings(settings) }

	return (
		<div className="flex flex-col gap-5 pb-6">
			{SPECIMEN_SIZES.map(size => (
				<div
					key={size}
					className="flex min-w-0 items-baseline gap-4"
				>
					<span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">{t("previewFontSampleSize", { size })}</span>
					<p
						className="min-w-0 leading-tight break-words"
						style={{ ...style, fontSize: size }}
					>
						{text}
					</p>
				</div>
			))}
			{axes.length === 0 ? null : (
				<section className="flex flex-col gap-2 border-t border-border/50 pt-4">
					<h3 className="text-xs font-medium text-muted-foreground">{t("previewFontAxes")}</h3>
					{axes.map(axis => (
						<AxisSlider
							key={axis.tag}
							axis={axis}
							value={settings.get(axis.tag) ?? axis.default}
							onChange={value => {
								onAxis(axis.tag, value)
							}}
						/>
					))}
				</section>
			)}
		</div>
	)
}

function FontInfoCard({ info, title }: { info: FontInfo; title: string }) {
	const { t } = useTranslation("preview")
	const sections: MetadataSectionData[] = [
		{
			title: t("previewFontInfoSectionFont"),
			fields: [
				{ label: t("previewFontInfoFormat"), value: t(FORMAT_KEYS[fontFormat(info)]) },
				{ label: t("previewFontInfoOutlines"), value: t(OUTLINE_KEYS[info.outlines]) },
				{ label: t("previewFontInfoGlyphs"), value: formatCount(info.glyphCount) },
				{ label: t("previewFontInfoCharacters"), value: formatCount(info.codePointCount) },
				{ label: t("previewFontInfoUnitsPerEm"), value: formatCount(info.unitsPerEm) },
				{ label: t("previewFontInfoWeight"), value: String(info.weight) },
				{ label: t("previewFontInfoStyle"), value: t(info.italic ? "previewFontStyleItalic" : "previewFontStyleUpright") },
				{ label: t("previewFontInfoEmbedding"), value: t(EMBEDDING_KEYS[fontEmbedding(info.fsType)]) }
			]
		}
	]
	const names = info.names.flatMap(name => {
		const key = NAME_KEYS[name.id]

		return key === undefined ? [] : [{ label: t(key), value: name.value, copy: name.value }]
	})

	if (names.length > 0) {
		sections.push({ title: t("previewFontInfoSectionNames"), fields: names })
	}

	if (info.axes.length > 0) {
		sections.push({
			title: t("previewFontInfoSectionAxes"),
			fields: info.axes.map(axis => ({
				label: axis.name === undefined ? axis.tag : `${axis.name} (${axis.tag})`,
				value: t("previewFontAxisRange", { min: axis.min, max: axis.max, value: axis.default })
			}))
		})
	}

	return (
		<MetadataCard
			title={title}
			sections={sections}
		/>
	)
}

function FontView({ item, bytes }: { item: DriveItem; bytes: Uint8Array }) {
	const { t } = useTranslation("preview")
	const family = `filen-preview-${item.data.uuid}`
	const face = useFontFace(bytes, family)
	const info = useFontInfo(bytes)
	const [tab, setTab] = useState<FontTab>("specimen")
	const [typed, setTyped] = useState<string | null>(null)
	const [settings, setSettings] = useState<ReadonlyMap<string, number>>(new Map())
	const ready = info.status === "ready" ? info : null
	const pangram = t("previewFontPangram")
	const sample = typed ?? (ready === null ? pangram : defaultSample(ready.info, ready.glyphs, pangram))
	const title = (ready === null ? undefined : (nameOf(ready.info, 4) ?? nameOf(ready.info, 1))) ?? driveItemName(item)
	const summary =
		ready === null
			? []
			: [
					nameOf(ready.info, 16) ?? nameOf(ready.info, 1),
					nameOf(ready.info, 17) ?? nameOf(ready.info, 2),
					t(FORMAT_KEYS[fontFormat(ready.info)]),
					t("previewFontGlyphCount", { count: ready.info.glyphCount })
				].filter(part => part !== undefined)

	if (face.status === "failed" && info.status === "failed") {
		return (
			<PreviewUnsupportedState
				item={item}
				message={t("previewFontLoadFailed")}
			/>
		)
	}

	const faceBody = (render: () => ReactNode) =>
		face.status === "failed" ? (
			<PreviewUnsupportedState
				item={item}
				message={t("previewFontLoadFailed")}
			/>
		) : face.status === "loading" ? (
			<PreviewLoading />
		) : (
			render()
		)

	return (
		<Tabs
			value={tab}
			onValueChange={(value: unknown) => {
				if (isFontTab(value)) setTab(value)
			}}
			className="flex size-full min-h-0 flex-col gap-0"
		>
			<div className="flex flex-col gap-2 px-4 pt-3 pb-2">
				{summary.length === 0 ? null : <p className="truncate text-sm text-muted-foreground">{summary.join(" · ")}</p>}
				<div className="flex flex-wrap items-center gap-3">
					<TabsList>
						<TabsTrigger value="specimen">{t("previewFontTabSpecimen")}</TabsTrigger>
						<TabsTrigger value="glyphs">{t("previewFontTabGlyphs")}</TabsTrigger>
						<TabsTrigger value="info">{t("previewFontTabInfo")}</TabsTrigger>
					</TabsList>
					{tab === "specimen" && face.status === "loaded" ? (
						<Input
							aria-label={t("previewFontSampleLabel")}
							placeholder={t("previewFontSamplePlaceholder")}
							value={typed ?? ""}
							className="max-w-80 min-w-40 flex-1"
							onChange={event => {
								setTyped(event.target.value === "" ? null : event.target.value)
							}}
						/>
					) : null}
				</div>
			</div>
			<TabsContent
				value="specimen"
				className="min-h-0 flex-1 overflow-auto px-4"
			>
				{faceBody(() => (
					<Specimen
						family={family}
						text={sample}
						axes={ready === null ? [] : adjustableAxes(ready.info.axes)}
						settings={settings}
						onAxis={(tag, value) => {
							setSettings(previous => new Map(previous).set(tag, value))
						}}
					/>
				))}
			</TabsContent>
			<TabsContent
				value="glyphs"
				className="flex min-h-0 flex-1 flex-col"
			>
				{faceBody(() =>
					info.status === "failed" ? (
						<PreviewErrorState message={t("previewFontInfoFailed")} />
					) : ready === null ? (
						<PreviewLoading />
					) : ready.glyphs.count === 0 ? (
						<PreviewErrorState message={t("previewFontNoGlyphs")} />
					) : (
						<GlyphGrid
							family={family}
							glyphs={ready.glyphs}
							settings={variationSettings(settings)}
						/>
					)
				)}
			</TabsContent>
			<TabsContent
				value="info"
				className="min-h-0 flex-1 overflow-auto px-4 pb-6"
			>
				{info.status === "failed" ? (
					<PreviewErrorState message={t("previewFontInfoFailed")} />
				) : ready === null ? (
					<PreviewLoading />
				) : (
					<div className="mx-auto max-w-2xl">
						<FontInfoCard
							info={ready.info}
							title={title}
						/>
					</div>
				)}
			</TabsContent>
		</Tabs>
	)
}

// A font file: its specimen at several sizes (with a variable font's axes), every glyph it maps, and its names and
// facts. The bytes stay in the preview cache for the FontFace; the worker reads only copies.
export function FontViewer({ item }: { item: DriveItem }) {
	const result = usePreviewBytes(item)

	return (
		<PreviewGate result={result}>
			{ready => (
				<FontView
					item={item}
					bytes={ready.bytes}
				/>
			)}
		</PreviewGate>
	)
}
