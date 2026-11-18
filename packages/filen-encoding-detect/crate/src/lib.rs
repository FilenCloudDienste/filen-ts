//! Legacy text encoding detection for the Filen apps: chardetng behind a small owned API. The web build
//! exposes it as a C ABI (`wasm` module) that JavaScript calls without generated glue.
//!
//! Callers ask only once the bytes are known not to be Unicode (no BOM, not UTF-16, not UTF-8): the guess
//! never answers UTF-8.

#![deny(unsafe_code)]
#![deny(unsafe_op_in_unsafe_fn)]
#![warn(clippy::pedantic)]

use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};

pub mod boundary;
#[cfg(target_arch = "wasm32")]
mod wasm;

/// The legacy encoding `bytes` most likely are, as its WHATWG name in lower case (`windows-1251`,
/// `shift_jis`). `last`: the bytes are the whole file, not a prefix of it (a sequence cut at the end is
/// then not held against an encoding). `None` when the bytes hold no evidence: they are valid UTF-8 (all
/// ASCII included), where chardetng would only name its generic default unscored.
#[must_use]
pub fn guess(bytes: &[u8], last: bool) -> Option<String> {
    // ISO-2022-JP is 7-bit: valid UTF-8, so never asked about.
    let mut detector = EncodingDetector::new(Iso2022JpDetection::Deny);

    detector.feed(bytes, last);

    // Allowing UTF-8 changes only the answer while the UTF-8 candidate is alive; otherwise both score the
    // legacy candidates alike.
    let encoding = detector.guess(None, Utf8Detection::Allow);

    (encoding.name() != "UTF-8").then(|| encoding.name().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::guess as guess_some;

    fn guess(bytes: &[u8], last: bool) -> String {
        guess_some(bytes, last).expect("a legacy sample has a guess")
    }

    fn encode(text: &str, encoding: &'static encoding_rs::Encoding) -> Vec<u8> {
        let (bytes, _, unmappable) = encoding.encode(text);

        assert!(!unmappable, "{text} is not in {}", encoding.name());

        bytes.into_owned()
    }

    #[test]
    fn guesses_cyrillic() {
        let text = "Съешь же ещё этих мягких французских булок, да выпей чаю. Широкая электрификация южных губерний.";

        assert_eq!(
            guess(&encode(text, encoding_rs::WINDOWS_1251), true),
            "windows-1251"
        );
    }

    #[test]
    fn guesses_central_european() {
        let text = "Příliš žluťoučký kůň úpěl ďábelské ódy. Zażółć gęślą jaźń, a może nie? Šťastný úsměv, větší čeština.";

        assert_eq!(
            guess(&encode(text, encoding_rs::WINDOWS_1250), true),
            "windows-1250"
        );
    }

    #[test]
    fn guesses_japanese() {
        let text =
            "いろはにほへと ちりぬるを わかよたれそ つねならむ。日本語のテキストファイルです。";

        assert_eq!(
            guess(&encode(text, encoding_rs::SHIFT_JIS), true),
            "shift_jis"
        );
    }

    #[test]
    fn guesses_simplified_chinese() {
        let text = "我能吞下玻璃而不伤身体。这是一个简体中文的文本文件，用于测试编码检测。";

        assert_eq!(guess(&encode(text, encoding_rs::GBK), true), "gbk");
    }

    #[test]
    fn guesses_korean() {
        let text = "다람쥐 헌 쳇바퀴에 타고파. 키스의 고유조건은 입술끼리 만나야 하고 특별한 기술은 필요치 않다.";

        assert_eq!(guess(&encode(text, encoding_rs::EUC_KR), true), "euc-kr");
    }

    #[test]
    fn has_no_guess_without_evidence() {
        assert_eq!(guess_some(b"plain ascii", true), None);
        assert_eq!(guess_some(b"plain ascii", false), None);
        assert_eq!(guess_some("héllo wörld".as_bytes(), true), None);
        assert_eq!(guess_some(b"", true), None);
    }

    #[test]
    fn guesses_after_an_ascii_head() {
        let mut bytes = b"-- an ASCII licence header\n".repeat(64);

        bytes.extend(encode(
            "Съешь же ещё этих мягких французских булок, да выпей чаю.",
            encoding_rs::WINDOWS_1251,
        ));

        assert_eq!(guess(&bytes, true), "windows-1251");
    }

    #[test]
    fn takes_a_prefix_cut_inside_a_character() {
        let bytes = encode(
            "いろはにほへと ちりぬるを わかよたれそ つねならむ",
            encoding_rs::SHIFT_JIS,
        );

        assert_eq!(guess(&bytes[..bytes.len() - 1], false), "shift_jis");
    }
}
