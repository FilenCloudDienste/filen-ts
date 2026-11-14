import { useEffect, useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { PlusIcon, Redo2Icon, Undo2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import type { SavedPdfSignature } from "@filen/shared/pdfSignatures"
import {
	normalizeStrokes,
	type PdfSignatureImage,
	type PdfSignatureRole,
	type PdfVisualSignature
} from "@filen/office/core/pdfedit/visualSignature"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createHistory } from "@/lib/editHistory"
import { useIsOnline } from "@/lib/useIsOnline"
import { log } from "@/lib/log"
import { SignaturePad } from "@/features/pdf/fillSign/signaturePad"
import {
	imageFileSignature,
	loadSignatureFont,
	renderTypedSignature,
	SIGNATURE_FONT_FAMILY,
	SIGNATURE_INK,
	strokesPath
} from "@/features/pdf/fillSign/signatureRender"
import { loadSavedSignatures, savedSignatures, savedVisualSignature, useSavedSignatures } from "@/features/pdf/fillSign/savedSignatures"

// "Add signature" / "Add initials": a row of the saved ones (and New), or a new one drawn, typed in the signature
// font or taken from a picture; "Save for reuse" keeps a new one for every device. Place hands the result to
// `onPlace` (the caller places it on the page) and closes.

export interface SignatureDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	role: PdfSignatureRole
	onPlace: (signature: PdfVisualSignature) => void
	// Prefills the Type tab (the author name; initials are derived from it).
	defaultName?: string | undefined
}

type Strokes = readonly (readonly number[])[]
type SignatureTab = "draw" | "type" | "image"

export function SignatureDialog({ open, onOpenChange, role, onPlace, defaultName }: SignatureDialogProps) {
	const { t } = useTranslation("preview")

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent
				data-preview-surface
				className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
			>
				<DialogHeader>
					<DialogTitle>
						{t(role === "signature" ? "previewPdfSignatureDialogTitle" : "previewPdfInitialsDialogTitle")}
					</DialogTitle>
					<DialogDescription>{t("previewPdfSignatureDialogDescription")}</DialogDescription>
				</DialogHeader>
				{open ? (
					<SignatureDialogBody
						role={role}
						defaultName={defaultName}
						onPlace={signature => {
							onPlace(signature)
							onOpenChange(false)
						}}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Initials from a name: the first character of each word, at most three.
function initialsOf(name: string): string {
	return name
		.trim()
		.split(/\s+/u)
		.slice(0, 3)
		.map(word => GRAPHEMES.segment(word)[Symbol.iterator]().next().value?.segment ?? "")
		.join("")
		.toLocaleUpperCase()
}

function SignatureDialogBody({
	role,
	defaultName,
	onPlace
}: {
	role: PdfSignatureRole
	defaultName: string | undefined
	onPlace: (signature: PdfVisualSignature) => void
}) {
	const { t } = useTranslation("preview")
	const id = useId()
	const saved = useSavedSignatures()
	const online = useIsOnline()
	const list = role === "signature" ? saved.signatures : saved.initials
	const [picked, setPicked] = useState<string | null>(null)
	const [chosenNew, setChosenNew] = useState(false)
	const [tab, setTab] = useState<SignatureTab>("draw")
	const [history] = useState(() => createHistory<Strokes>([]))
	const [strokes, setStrokes] = useState<Strokes>([])
	const [typed, setTyped] = useState(() => (role === "initials" ? initialsOf(defaultName ?? "") : (defaultName ?? "").trim()))
	const [fontReady, setFontReady] = useState(false)
	// The chosen picture and an object URL showing it (revoked when replaced or on close).
	const [picture, setPicture] = useState<{ image: PdfSignatureImage; url: string } | null>(null)
	const image = picture?.image ?? null
	const [imageFailed, setImageFailed] = useState(false)
	const [saveForReuse, setSaveForReuse] = useState(true)
	const [placing, setPlacing] = useState(false)
	// A saved entry is offered first; New (or no saved entries) shows the tabs.
	const selected = chosenNew ? null : (list.find(item => item.id === picked) ?? list[0] ?? null)
	const canSave = online && !saved.readOnly

	useEffect(() => {
		loadSavedSignatures().catch((error: unknown) => {
			log.warn("pdf", "saved signatures not loaded", { error })
		})
	}, [])

	useEffect(() => {
		if (tab !== "type" || fontReady) return

		let live = true

		loadSignatureFont().then(
			() => {
				if (live) setFontReady(true)
			},
			(error: unknown) => {
				log.warn("pdf", "signature font not loaded", { error })
			}
		)

		return () => {
			live = false
		}
	}, [tab, fontReady])

	useEffect(() => {
		if (picture === null) return

		const url = picture.url

		return () => {
			URL.revokeObjectURL(url)
		}
	}, [picture])

	function pushStrokes(next: Strokes): void {
		history.push(next)
		setStrokes(history.current)
	}

	function newSignature(): Promise<PdfVisualSignature | null> {
		if (tab === "draw") return Promise.resolve(normalizeStrokes(strokes))
		if (tab === "type") return renderTypedSignature(typed)

		return Promise.resolve(image)
	}

	function place(): void {
		if (selected !== null) {
			onPlace(savedVisualSignature(selected))

			return
		}

		setPlacing(true)
		newSignature().then(
			signature => {
				setPlacing(false)

				if (signature === null) return

				if (saveForReuse && canSave) {
					savedSignatures.save(role, signature).catch((error: unknown) => {
						log.warn("pdf", "signature not saved for reuse", { error })
						toast.error(t("previewPdfSignatureSaveFailed"))
					})
				}

				onPlace(signature)
			},
			(error: unknown) => {
				setPlacing(false)
				log.warn("pdf", "signature not made", { error })
				toast.error(t("previewPdfSignatureImageFailed"))
			}
		)
	}

	function clear(): void {
		if (tab === "draw") pushStrokes([])
		else if (tab === "type") setTyped("")
		else {
			setPicture(null)
			setImageFailed(false)
		}
	}

	function chooseImage(file: File): void {
		setImageFailed(false)
		imageFileSignature(file).then(
			chosen => {
				setPicture({ image: chosen, url: URL.createObjectURL(new Blob([chosen.png.slice()], { type: "image/png" })) })
			},
			(error: unknown) => {
				log.warn("pdf", "signature image not read", { error })
				setPicture(null)
				setImageFailed(true)
			}
		)
	}

	const ready =
		selected !== null || (tab === "draw" ? strokes.length > 0 : tab === "type" ? typed.trim() !== "" && fontReady : image !== null)
	const empty = tab === "draw" ? strokes.length === 0 : tab === "type" ? typed === "" : image === null

	return (
		<div className="flex min-w-0 flex-col gap-4">
			{list.length > 0 ? (
				<div className="flex flex-col gap-2">
					<span
						id={`${id}-saved`}
						className="text-xs font-medium text-muted-foreground"
					>
						{t(role === "signature" ? "previewPdfSignatureSaved" : "previewPdfInitialsSaved")}
					</span>
					<div
						role="group"
						aria-labelledby={`${id}-saved`}
						className="flex flex-wrap gap-2"
					>
						{list.map((item, index) => (
							<SavedSignatureButton
								key={item.id}
								item={item}
								label={t(role === "signature" ? "previewPdfSignatureSavedItem" : "previewPdfInitialsSavedItem", {
									index: index + 1
								})}
								pressed={selected?.id === item.id}
								onClick={() => {
									setPicked(item.id)
									setChosenNew(false)
								}}
							/>
						))}
						<Button
							type="button"
							variant="outline"
							className="h-14"
							aria-pressed={selected === null}
							onClick={() => {
								setChosenNew(true)
							}}
						>
							<PlusIcon />
							{t("previewPdfSignatureNew")}
						</Button>
					</div>
				</div>
			) : null}
			{selected === null ? (
				<Tabs
					value={tab}
					onValueChange={(value: unknown) => {
						if (value === "draw" || value === "type" || value === "image") setTab(value)
					}}
				>
					<TabsList className="w-full">
						<TabsTrigger value="draw">{t("previewPdfSignatureDraw")}</TabsTrigger>
						<TabsTrigger value="type">{t("previewPdfSignatureType")}</TabsTrigger>
						<TabsTrigger value="image">{t("previewPdfSignatureImage")}</TabsTrigger>
					</TabsList>
					<TabsContent
						value="draw"
						className="flex flex-col gap-2"
					>
						<SignaturePad
							strokes={strokes}
							label={t("previewPdfSignaturePad")}
							hint={t("previewPdfSignaturePadHint")}
							onStroke={stroke => {
								pushStrokes([...strokes, stroke])
							}}
						/>
						<div className="flex justify-end gap-1">
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("previewPdfSignatureUndoStroke")}
								title={t("previewPdfSignatureUndoStroke")}
								disabled={!history.canUndo}
								onClick={() => {
									setStrokes(history.undo())
								}}
							>
								<Undo2Icon />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("previewPdfSignatureRedoStroke")}
								title={t("previewPdfSignatureRedoStroke")}
								disabled={!history.canRedo}
								onClick={() => {
									setStrokes(history.redo())
								}}
							>
								<Redo2Icon />
							</Button>
						</div>
					</TabsContent>
					<TabsContent
						value="type"
						className="flex flex-col gap-2"
					>
						<Label htmlFor={`${id}-typed`}>
							{t(role === "signature" ? "previewPdfSignatureTypeLabel" : "previewPdfInitialsTypeLabel")}
						</Label>
						<Input
							id={`${id}-typed`}
							value={typed}
							autoComplete="off"
							spellCheck={false}
							maxLength={role === "signature" ? 80 : 8}
							onChange={event => {
								setTyped(event.target.value)
							}}
						/>
						<div
							aria-hidden
							className="flex h-28 items-center justify-center overflow-hidden rounded-xl border border-input bg-white px-4 text-5xl"
							style={{ fontFamily: fontReady ? `"${SIGNATURE_FONT_FAMILY}"` : undefined, color: SIGNATURE_INK }}
						>
							<span className="truncate">{typed}</span>
						</div>
					</TabsContent>
					<TabsContent
						value="image"
						className="flex flex-col gap-2"
					>
						<input
							id={`${id}-file`}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif,.hif"
							className="sr-only"
							onChange={event => {
								const file = event.target.files?.[0]

								event.target.value = ""

								if (file !== undefined) chooseImage(file)
							}}
						/>
						<div className="flex h-28 items-center justify-center overflow-hidden rounded-xl border border-input bg-white">
							{picture === null ? (
								<Button
									type="button"
									variant="outline"
									onClick={() => {
										document.getElementById(`${id}-file`)?.click()
									}}
								>
									{t("previewPdfSignatureChooseImage")}
								</Button>
							) : (
								<img
									src={picture.url}
									alt=""
									className="max-h-full max-w-full object-contain"
								/>
							)}
						</div>
						{imageFailed ? (
							<p
								role="alert"
								className="text-xs text-destructive"
							>
								{t("previewPdfSignatureImageFailed")}
							</p>
						) : null}
					</TabsContent>
				</Tabs>
			) : (
				<div className="flex h-32 items-center justify-center rounded-xl border border-input bg-white p-3">
					<SignaturePreview item={selected} />
				</div>
			)}
			{selected === null ? (
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-2">
						<input
							id={`${id}-reuse`}
							type="checkbox"
							className="size-4 accent-primary"
							checked={saveForReuse && canSave}
							disabled={!canSave}
							onChange={event => {
								setSaveForReuse(event.target.checked)
							}}
						/>
						<Label htmlFor={`${id}-reuse`}>{t("previewPdfSignatureSaveForReuse")}</Label>
					</div>
					{saved.readOnly ? <p className="text-xs text-muted-foreground">{t("previewPdfSignatureSaveReadOnly")}</p> : null}
				</div>
			) : null}
			<DialogFooter>
				{selected === null ? (
					<Button
						type="button"
						variant="outline"
						disabled={empty || placing}
						onClick={clear}
					>
						{t("previewPdfSignatureClear")}
					</Button>
				) : null}
				<Button
					type="button"
					disabled={!ready || placing}
					onClick={place}
				>
					{t("previewPdfSignaturePlace")}
				</Button>
			</DialogFooter>
		</div>
	)
}

function SavedSignatureButton({
	item,
	label,
	pressed,
	onClick
}: {
	item: SavedPdfSignature
	label: string
	pressed: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={pressed}
			className={cn(
				"flex h-14 w-28 items-center justify-center rounded-xl border bg-white p-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
				pressed ? "border-primary ring-2 ring-primary/40" : "border-input"
			)}
			onClick={onClick}
		>
			<SignaturePreview item={item} />
		</button>
	)
}

// A saved signature drawn as it will be placed: strokes as an SVG path, an image as itself.
export function SignaturePreview({ item }: { item: SavedPdfSignature }) {
	const data = item.data

	if (data.kind === "image") {
		return (
			<img
				src={`data:image/png;base64,${data.png}`}
				alt=""
				className="max-h-full max-w-full object-contain"
			/>
		)
	}

	return (
		<svg
			viewBox={`0 0 ${String(data.width)} ${String(data.height)}`}
			className="max-h-full max-w-full"
			aria-hidden
		>
			<path
				d={strokesPath(data.strokes)}
				fill="none"
				stroke={SIGNATURE_INK}
				strokeWidth={2}
				strokeLinecap="round"
				strokeLinejoin="round"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	)
}
