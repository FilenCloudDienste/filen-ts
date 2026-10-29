// GitHub now serves facebook/hermes tarballs under meta-hermes-<sha>/, which react-native's unzipHermes
// does not strip, so CMake finds no CMakeLists.txt. Inert once react-native ships facebook/react-native#59589; drop then.
// The flag keeps the strip single when the script is loaded twice (init.d and -I).
gradle.lifecycle.beforeProject {
  if (path == ":packages:react-native:ReactAndroid:hermes-engine") {
    afterEvaluate {
      if (!extra.has("hermesUnzipShim") && buildFile.readText().contains("startsWith(\"facebook-hermes-\")")) {
        extra["hermesUnzipShim"] = true
        tasks.named<Copy>("unzipHermes") {
          eachFile { path = path.substringAfter("/") }
          includeEmptyDirs = false
        }
      }
    }
  }
}
