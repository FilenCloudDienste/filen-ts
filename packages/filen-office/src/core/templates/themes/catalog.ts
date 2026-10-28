import { FILEN_THEME, themeColors as c, variant as v, type FilenTheme } from "./model"

// The gallery: eight Filen themes with four colour variants each. Kept apart from model.ts so that the blank
// templates (which use only FILEN_THEME) do not carry the whole gallery into the page bundle.

export const FILEN_THEMES: readonly FilenTheme[] = [
	FILEN_THEME,
	{
		id: "slate",
		major: "Segoe UI",
		minor: "Segoe UI",
		decoration: "leftBar",
		variants: [
			v(c("0F172A", "FFFFFF", "334155", "F1F5F9", ["3B82F6", "14B8A6", "F43F5E", "A855F7", "F59E0B", "22C55E"], "2563EB", "7C3AED")),
			v(c("0F172A", "FFFFFF", "1E3A8A", "EFF6FF", ["1D4ED8", "0891B2", "64748B", "CA8A04", "9333EA", "15803D"], "1D4ED8", "6D28D9")),
			v(c("0F172A", "FFFFFF", "7C2D12", "FFF7ED", ["EA580C", "0EA5E9", "78716C", "65A30D", "DB2777", "4F46E5"], "C2410C", "9A3412")),
			v(c("0B1120", "F8FAFC", "1E293B", "334155", ["38BDF8", "2DD4BF", "FB7185", "C084FC", "FBBF24", "4ADE80"], "7DD3FC", "C4B5FD"), {
				dark: true
			})
		]
	},
	{
		id: "harbor",
		major: "Georgia",
		minor: "Calibri",
		decoration: "bottomBand",
		variants: [
			v(c("0C1A2B", "FFFFFF", "16324F", "EEF4F9", ["1E5A8C", "D97706", "4B7F8C", "A3A3A3", "2F855A", "B83280"], "1E5A8C", "6B46C1")),
			v(c("0C1A2B", "FFFFFF", "1F3B2C", "F0F7F2", ["2F6B4F", "C05621", "5A7D6E", "B7791F", "2C7A7B", "805AD5"], "276749", "6B46C1")),
			v(c("1A1410", "FFFDF8", "4A3728", "F7F1E8", ["8C5A2B", "2B6CB0", "9C7B5B", "4A7C59", "B7472A", "6B5B95"], "8C5A2B", "6B5B95")),
			v(c("0A1622", "F4F8FB", "12263A", "1D3A55", ["5FA8D3", "F6AD55", "81B29A", "E07A5F", "B8C0FF", "F2CC8F"], "90CDF4", "D6BCFA"), {
				dark: true
			})
		]
	},
	{
		id: "ember",
		major: "Cambria",
		minor: "Calibri",
		decoration: "topRule",
		variants: [
			v(c("1C1917", "FFFFFF", "44403C", "FAFAF9", ["C2410C", "B45309", "57534E", "BE123C", "0F766E", "4338CA"], "C2410C", "7E22CE")),
			v(c("1C1917", "FFFFFF", "7F1D1D", "FEF2F2", ["B91C1C", "D97706", "78716C", "9D174D", "0369A1", "15803D"], "B91C1C", "7E22CE")),
			v(c("1C1917", "FFFBEB", "713F12", "FEF3C7", ["CA8A04", "C2410C", "78716C", "65A30D", "0E7490", "9333EA"], "A16207", "7E22CE")),
			v(c("120D0A", "FAF5F0", "292018", "3D2F24", ["FB923C", "FBBF24", "D6D3D1", "FB7185", "5EEAD4", "A5B4FC"], "FDBA74", "D8B4FE"), {
				dark: true
			})
		]
	},
	{
		id: "meadow",
		major: "Arial",
		minor: "Arial",
		decoration: "sideBand",
		variants: [
			v(c("14231A", "FFFFFF", "1F4D2E", "F0FDF4", ["16A34A", "0891B2", "65A30D", "CA8A04", "0D9488", "DB2777"], "15803D", "7C3AED")),
			v(c("14231A", "FFFFFF", "365314", "F7FEE7", ["4D7C0F", "B45309", "0F766E", "A16207", "4338CA", "BE185D"], "3F6212", "7C3AED")),
			v(c("10221F", "FFFFFF", "134E4A", "ECFEFF", ["0E7490", "059669", "0284C7", "D97706", "7C3AED", "E11D48"], "0E7490", "6D28D9")),
			v(c("0A1A12", "F0FDF4", "11261A", "1C3A28", ["4ADE80", "22D3EE", "A3E635", "FDE047", "5EEAD4", "F9A8D4"], "86EFAC", "C4B5FD"), {
				dark: true
			})
		]
	},
	{
		id: "ledger",
		major: "Times New Roman",
		minor: "Arial",
		decoration: "frame",
		variants: [
			v(c("111111", "FFFFFF", "2B2B2B", "F5F5F4", ["1F3A5F", "9B2C2C", "4A5568", "B7791F", "2F855A", "553C9A"], "1F3A5F", "553C9A")),
			v(c("111111", "FFFFFF", "3C2A21", "FAF6F0", ["7B341E", "1E4E79", "6B5E50", "8A6D1E", "2F6B4F", "5B3A7A"], "7B341E", "5B3A7A")),
			v(c("111111", "FFFFFF", "1A2E35", "F2F7F7", ["2C5F6E", "A0522D", "5F6B6D", "8F7A3B", "3B6E4F", "6A4C93"], "2C5F6E", "6A4C93")),
			v(c("0E0E0E", "F5F5F4", "1C1C1C", "2E2E2E", ["90CDF4", "FEB2B2", "CBD5E0", "F6E05E", "9AE6B4", "D6BCFA"], "BEE3F8", "E9D8FD"), {
				dark: true
			})
		]
	},
	{
		id: "studio",
		major: "Calibri",
		minor: "Calibri",
		decoration: "corner",
		variants: [
			v(c("1E1B4B", "FFFFFF", "312E81", "EEF2FF", ["4F46E5", "EC4899", "06B6D4", "F59E0B", "10B981", "8B5CF6"], "4338CA", "7C3AED"), {
				background: "gradient"
			}),
			v(c("172554", "FFFFFF", "1E40AF", "EFF6FF", ["2563EB", "06B6D4", "8B5CF6", "F43F5E", "F59E0B", "22C55E"], "1D4ED8", "7C3AED"), {
				background: "gradient"
			}),
			v(c("4A044E", "FFFFFF", "86198F", "FDF4FF", ["C026D3", "F97316", "0EA5E9", "84CC16", "E11D48", "6366F1"], "A21CAF", "7C3AED"), {
				background: "gradient"
			}),
			v(c("0B0A1F", "EEF2FF", "1E1B4B", "312E81", ["818CF8", "F472B6", "22D3EE", "FCD34D", "34D399", "C4B5FD"], "A5B4FC", "DDD6FE"), {
				dark: true,
				background: "gradient"
			})
		]
	},
	{
		id: "typewriter",
		major: "Courier New",
		minor: "Arial",
		decoration: "titleRule",
		variants: [
			v(c("1A1A1A", "FFFFFF", "3F3F46", "F4F4F5", ["18181B", "DC2626", "71717A", "2563EB", "CA8A04", "16A34A"], "2563EB", "7C3AED")),
			v(c("1A1A1A", "FFFEF7", "44403C", "F5F0E1", ["3F3F46", "B91C1C", "78716C", "1D4ED8", "A16207", "15803D"], "1D4ED8", "6D28D9")),
			v(c("1A1A1A", "FFFFFF", "0C4A6E", "F0F9FF", ["0369A1", "E11D48", "64748B", "0D9488", "CA8A04", "7C3AED"], "0369A1", "7C3AED")),
			v(c("0A0A0A", "FAFAFA", "18181B", "27272A", ["E4E4E7", "F87171", "A1A1AA", "60A5FA", "FACC15", "4ADE80"], "93C5FD", "C4B5FD"), {
				dark: true
			})
		]
	}
]

export function filenTheme(id: string): FilenTheme | undefined {
	return FILEN_THEMES.find(theme => theme.id === id)
}
