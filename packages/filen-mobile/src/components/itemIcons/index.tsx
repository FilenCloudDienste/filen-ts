import { ExpoImage } from "@/components/ui/image"
import { memo } from "react"
import { Paths } from "expo-file-system"
import { isValidHexColor, cn } from "@filen/utils"
import { memoize } from "es-toolkit/function"
import { type DirColor, DirColor_Tags } from "@filen/sdk-rs"

export const FileIcon = memo(
	({ name, width, height, className }: { name: string; width?: number; height?: number; className?: string }) => {
		const source = (() => {
			const extname = Paths.extname(name.trim().toLowerCase())

			switch (extname) {
				case ".dmg":
				case ".iso": {
					return require("@/components/itemIcons/svg/iso.svg")
				}

				case ".cad": {
					return require("@/components/itemIcons/svg/cad.svg")
				}

				case ".psd": {
					return require("@/components/itemIcons/svg/psd.svg")
				}

				case ".apk": {
					return require("@/components/itemIcons/svg/android.svg")
				}

				case ".ipa": {
					return require("@/components/itemIcons/svg/apple.svg")
				}

				case ".txt": {
					return require("@/components/itemIcons/svg/txt.svg")
				}

				case ".pdf": {
					return require("@/components/itemIcons/svg/pdf.svg")
				}

				case ".gif":
				case ".png":
				case ".jpg":
				case ".jpeg":
				case ".heic":
				case ".webp":
				case ".tiff":
				case ".bmp":
				case ".jfif":
				case ".jpe":
				case ".svg": {
					return require("@/components/itemIcons/svg/image.svg")
				}

				case ".pkg":
				case ".rar":
				case ".tar":
				case ".zip":
				case ".7zip": {
					return require("@/components/itemIcons/svg/archive.svg")
				}

				case ".wmv":
				case ".mov":
				case ".avi":
				case ".mkv":
				case ".webm":
				case ".mp4": {
					return require("@/components/itemIcons/svg/video.svg")
				}

				case ".mp3": {
					return require("@/components/itemIcons/svg/audio.svg")
				}

				case ".js":
				case ".cjs":
				case ".mjs":
				case ".jsx":
				case ".tsx":
				case ".ts":
				case ".cpp":
				case ".c":
				case ".php":
				case ".htm":
				case ".html5":
				case ".html":
				case ".css":
				case ".css3":
				case ".sass":
				case ".xml":
				case ".json":
				case ".sql":
				case ".java":
				case ".kt":
				case ".swift":
				case ".py3":
				case ".py":
				case ".cmake":
				case ".cs":
				case ".dart":
				case ".dockerfile":
				case ".go":
				case ".less":
				case ".yaml":
				case ".vue":
				case ".svelte":
				case ".vbs":
				case ".toml":
				case ".cobol":
				case ".h":
				case ".conf":
				case ".sh":
				case ".rs":
				case ".rb":
				case ".ps1":
				case ".bat":
				case ".ps":
				case ".protobuf":
				case ".ahk":
				case ".litcoffee":
				case ".coffee":
				case ".proto": {
					return require("@/components/itemIcons/svg/code.svg")
				}

				case ".jar":
				case ".exe":
				case ".bin": {
					return require("@/components/itemIcons/svg/exe.svg")
				}

				case ".doc":
				case ".docx": {
					return require("@/components/itemIcons/svg/doc.svg")
				}

				case ".ppt":
				case ".pptx": {
					return require("@/components/itemIcons/svg/ppt.svg")
				}

				case ".xls":
				case ".xlsx": {
					return require("@/components/itemIcons/svg/xls.svg")
				}

				default: {
					return require("@/components/itemIcons/svg/other.svg")
				}
			}
		})()

		return (
			<ExpoImage
				className={cn("shrink-0", className)}
				source={source}
				style={{
					width: width ?? 32,
					height: height ?? 32
				}}
				contentFit="contain"
				cachePolicy="disk"
			/>
		)
	}
)

export function shadeColor(color: string, decimal: number): string {
	const base = color.startsWith("#") ? 1 : 0

	let r = parseInt(color.substring(base, 3), 16)
	let g = parseInt(color.substring(base + 2, 5), 16)
	let b = parseInt(color.substring(base + 4, 7), 16)

	r = Math.round(r / decimal)
	g = Math.round(g / decimal)
	b = Math.round(b / decimal)

	r = r < 255 ? r : 255
	g = g < 255 ? g : 255
	b = b < 255 ? b : 255

	const rr = r.toString(16).length === 1 ? `0${r.toString(16)}` : r.toString(16)
	const gg = g.toString(16).length === 1 ? `0${g.toString(16)}` : g.toString(16)
	const bb = b.toString(16).length === 1 ? `0${b.toString(16)}` : b.toString(16)

	return `#${rr}${gg}${bb}`
}

export function directoryColorToHex(color: string | null): string {
	if (!color) {
		return "#85BCFF"
	}

	const hexColor = (
		color === "blue"
			? "#037AFF"
			: color === "gray"
				? "#8F8E93"
				: color === "green"
					? "#33C759"
					: color === "purple"
						? "#AF52DE"
						: color === "red"
							? "#FF3B30"
							: color.includes("#")
								? color
								: "#85BCFF"
	).toLowerCase()

	if (!isValidHexColor(hexColor)) {
		return "#85BCFF"
	}

	return hexColor
}

export function unwrapDirColor(color?: DirColor): string {
	if (!color) {
		return "default"
	}

	switch (color.tag) {
		case DirColor_Tags.Blue: {
			return "blue"
		}

		case DirColor_Tags.Gray: {
			return "gray"
		}

		case DirColor_Tags.Green: {
			return "green"
		}

		case DirColor_Tags.Purple: {
			return "purple"
		}

		case DirColor_Tags.Red: {
			return "red"
		}

		case DirColor_Tags.Custom: {
			return color.inner[0]
		}

		case DirColor_Tags.Default: {
			return "default"
		}

		default: {
			return "default"
		}
	}
}

export const directorySvg = memoize(
	({ color, width, height }: { color?: string | null; width?: string | number; height?: string | number }) => {
		const colors = (() => {
			if (!color || color === "default") {
				return {
					path1: "#5398DF",
					path2: "#85BCFF"
				}
			}

			const stringToColor = directoryColorToHex(color)

			return {
				path1: shadeColor(stringToColor, 1.3),
				path2: stringToColor
			}
		})()

		const w = typeof width === "number" ? `${width}px` : (width ?? "32px")
		const h = typeof height === "number" ? `${height}px` : (height ?? "32px")

		const svgTemplateString = `
        <svg
            width="${w}"
            height="${h}"
            style="vertical-align: middle; fill: currentcolor; overflow: hidden; flex-shrink: 0;"
            viewBox="0 0 1228 1024"
            version="1.1"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M1196.987733 212.5824v540.0576c0 39.594667-34.474667 71.3728-76.765866 71.3728H323.242667c-51.780267 0-88.746667-46.762667-73.250134-92.808533l126.737067-375.808H70.417067C31.675733 355.362133 0 326.4512 0 291.089067V98.372267C0 63.044267 31.675733 34.0992 70.417067 34.0992h378.811733c26.7264 0 51.029333 13.9264 63.010133 35.703467l39.048534 71.406933H1120.256c42.257067 0 76.8 32.119467 76.8 71.3728"
                fill="${colors.path1}"
            />
            <path
                d="M1128.721067 997.853867H68.266667a68.266667 68.266667 0 0 1-68.266667-68.266667V280.3712a68.266667 68.266667 0 0 1 68.266667-68.266667h1060.4544a68.266667 68.266667 0 0 1 68.266666 68.266667V929.5872a68.266667 68.266667 0 0 1-68.266666 68.266667"
                fill="${colors.path2}"
            />
        </svg>
    `.trim()

		return `data:image/svg+xml;base64,${btoa(svgTemplateString)}`
	}
)

export const DirectoryIcon = memo(
	({ color, width, height, className }: { color?: DirColor; width?: number; height?: number; className?: string }) => {
		const source = {
			uri: directorySvg({
				color: unwrapDirColor(color),
				width,
				height
			})
		}

		return (
			<ExpoImage
				className={cn("shrink-0", className)}
				source={source}
				style={{
					width: width ?? 32,
					height: height ?? 32
				}}
				contentFit="contain"
				cachePolicy="disk"
			/>
		)
	}
)
