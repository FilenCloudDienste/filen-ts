import { PRESET_ANGLE_ADJUSTS } from "../drawingml/geometry/presets.generated"

// A layout's dgm:adj value (§21.4.3.1) as the shape's a:avLst guide value. MS-OI29500 §2.1.1615(b): an adjustment
// a rotation handle turns is in degrees (60000ths of a degree in the guide); every other is a fraction (100000ths).
export function adjustGuideValue(preset: string, name: string, value: number): number {
	const angles = Object.hasOwn(PRESET_ANGLE_ADJUSTS, preset) ? PRESET_ANGLE_ADJUSTS[preset] : undefined

	return Math.round(value * (angles?.includes(name) === true ? 60000 : 100000))
}
