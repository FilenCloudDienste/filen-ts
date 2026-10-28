import type { ThemePreview } from "@/features/presentation/components/design/design.logic"

// A theme drawn small: its background, its decoration in accent 1, "Aa" in its heading font and colour, and its first
// three accents. 16:9 at `width` px; decorative (its button carries the name).

const W = 64
const H = 36

function Decoration({ preview }: { preview: ThemePreview }) {
	const accent = `#${preview.accents[0] ?? "000000"}`

	switch (preview.decoration) {
		case "leftBar":
			return (
				<rect
					x={0}
					y={0}
					width={1.5}
					height={H}
					fill={accent}
				/>
			)
		case "bottomBand":
			return (
				<rect
					x={0}
					y={H - 1.5}
					width={W}
					height={1.5}
					fill={accent}
				/>
			)
		case "topRule":
			return (
				<rect
					x={4.4}
					y={1.6}
					width={W - 8.8}
					height={0.6}
					fill={accent}
				/>
			)
		case "sideBand":
			return (
				<rect
					x={W - 2}
					y={0}
					width={2}
					height={H}
					fill={accent}
				/>
			)
		case "frame":
			return (
				<rect
					x={1.3}
					y={1.3}
					width={W - 2.6}
					height={H - 2.6}
					fill="none"
					stroke={accent}
					strokeWidth={0.6}
				/>
			)
		case "titleRule":
			return (
				<rect
					x={4.4}
					y={13}
					width={8}
					height={0.8}
					fill={accent}
				/>
			)
		case "corner":
			return (
				<path
					d={`M ${String(W)} ${String(H - 9)} L ${String(W)} ${String(H)} L ${String(W - 9)} ${String(H)} Z`}
					fill={accent}
				/>
			)
		case "none":
			return null
	}
}

export function ThemeSwatch({ preview, width = 64, id }: { preview: ThemePreview; width?: number; id: string }) {
	const gradient = preview.backgroundTo === undefined ? undefined : `design-swatch-${id}`

	return (
		<svg
			aria-hidden="true"
			width={width}
			height={(width * H) / W}
			viewBox={`0 0 ${String(W)} ${String(H)}`}
			// Inline, so a menu's icon size never shrinks it.
			style={{ width, height: (width * H) / W }}
			className="block shrink-0 rounded-[3px] ring-1 ring-border"
		>
			{gradient === undefined ? null : (
				<defs>
					<linearGradient
						id={gradient}
						x1="0"
						y1="0"
						x2="0"
						y2="1"
					>
						<stop
							offset="0"
							stopColor={`#${preview.background}`}
						/>
						<stop
							offset="1"
							stopColor={`#${preview.backgroundTo ?? preview.background}`}
						/>
					</linearGradient>
				</defs>
			)}
			<rect
				width={W}
				height={H}
				fill={gradient === undefined ? `#${preview.background}` : `url(#${gradient})`}
			/>
			<Decoration preview={preview} />
			<text
				x={5}
				y={22}
				fontSize={12}
				fill={`#${preview.text}`}
				style={{ fontFamily: preview.headingFont }}
			>
				Aa
			</text>
			{preview.accents.slice(0, 3).map((color, index) => (
				<rect
					key={color + String(index)}
					x={36 + index * 7}
					y={25}
					width={5.5}
					height={5.5}
					rx={1}
					fill={`#${color}`}
				/>
			))}
		</svg>
	)
}
