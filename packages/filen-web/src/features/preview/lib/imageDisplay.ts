import { createContext } from "react"

// What an image viewer tells the surface it is shown in, and what that surface tells it.

export interface ShownImage {
	readonly width: number
	readonly height: number
}

// Hears an image viewer under it put its picture on screen (an <img> loaded, a decoded bitmap drawn), with the
// picture's size: the comic reader reads ahead only then, and tells a two-page scan by it.
export const ImageShownContext = createContext<((image: ShownImage) => void) | null>(null)

// Which of several image viewers on screen takes the viewer's keys (a comic's spread, each page zoomed on its own);
// without one every viewer does.
export interface ImageKeyGroup {
	readonly owns: (element: Element) => boolean
}

export const ImageKeyGroupContext = createContext<ImageKeyGroup | null>(null)

// The file's grid thumbnail while it is already held in memory (never generated for this): an image viewer shows it
// blurred until its own picture is in.
export const ImagePlaceholderContext = createContext<string | null>(null)
