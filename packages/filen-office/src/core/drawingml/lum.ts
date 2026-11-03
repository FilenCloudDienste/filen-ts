// Office's Washout recolour (a:lum bright="70000" contrast="-70000") leaves a picture pale but legible, as LibreOffice
// draws it: the brightness it adds is taken as 50 %, where 70 % would turn every pixel white.
const WASHOUT_BRIGHTNESS = 0.7
const WASHOUT_CONTRAST = -0.7
const WASHOUT_DRAWN_BRIGHTNESS = 0.5

// a:lum as one linear transfer per channel (0..1): contrast scales about middle grey, by 1 + contrast below zero and by
// its reciprocal above, then brightness is added. [slope, intercept].
export function lumTransfer(brightness: number, contrast: number): [number, number] {
	const washout = Math.abs(brightness - WASHOUT_BRIGHTNESS) < 1e-6 && Math.abs(contrast - WASHOUT_CONTRAST) < 1e-6
	const slope = contrast < 0 ? 1 + contrast : 1 / (1 - contrast)

	return [slope, 0.5 - 0.5 * slope + (washout ? WASHOUT_DRAWN_BRIGHTNESS : brightness)]
}
