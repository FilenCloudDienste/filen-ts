// Ambient declaration for CSS side-effect imports — the DOM-component editors
// (@uiw/*, quill) and the global Tailwind/Uniwind stylesheet (@/global.css).
//
// Locally these resolve via expo/types (pulled in by the auto-generated
// expo-env.d.ts), but that file is git-ignored and CI does not regenerate it,
// so typecheck failed there with TS2882. Declaring it in a tracked file keeps
// typecheck stable in every environment.
declare module "*.css"
