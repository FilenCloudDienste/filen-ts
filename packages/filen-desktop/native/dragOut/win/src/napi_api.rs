//! The Node-API surface (`src/main/dragOut/addonWin.ts`). The only module that touches napi: test builds leave it out.

use std::path::PathBuf;

use napi::bindgen_prelude::{BigInt, Buffer, FnArgs, Function};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Error, Result, Status};
use napi_derive::napi;

use crate::descriptor::Entry;
use crate::slot::Registry;
use crate::source::{self, Image};
use crate::{Events, OperationResult, window_handle};

// Every drag's tickets, for complete/fail/abort from JS.
static REGISTRY: Registry = Registry::new();

// Weak: a pending call never keeps the event loop alive; non-blocking calls queue while main JS is busy (or blocked
// in DoDragDrop) and run in order afterwards.
type Callback<T> = ThreadsafeFunction<T, (), T, Status, false, true>;

struct JsEvents {
    contents: Callback<FnArgs<(u32, u32)>>,
    release: Callback<u32>,
    operation_end: Callback<&'static str>,
}

impl Events for JsEvents {
    fn contents(&self, ticket: u32, index: u32) -> bool {
        self.contents.call(
            (ticket, index).into(),
            ThreadsafeFunctionCallMode::NonBlocking,
        ) == Status::Ok
    }

    fn release(&self, ticket: u32) {
        let _ = self
            .release
            .call(ticket, ThreadsafeFunctionCallMode::NonBlocking);
    }

    fn operation_end(&self, result: OperationResult) {
        let _ = self
            .operation_end
            .call(result.as_str(), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

#[napi(object)]
pub struct EntryJs {
    pub path: String,
    pub directory: bool,
    pub size: BigInt,
    pub mtime_ms: Option<f64>,
}

#[napi(object)]
pub struct ImageJs {
    pub bgra: Buffer,
    pub width: u32,
    pub height: u32,
}

#[napi(object, object_to_js = false)]
pub struct BeginOptions<'a> {
    pub hwnd: Buffer,
    pub entries: Vec<EntryJs>,
    pub image: ImageJs,
    pub on_contents: Function<'a, FnArgs<(u32, u32)>, ()>,
    pub on_release: Function<'a, u32, ()>,
    pub on_operation_end: Function<'a, &'static str, ()>,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, message.into())
}

fn entry(js: EntryJs) -> Result<Entry> {
    let (negative, size, lossless) = js.size.get_u64();

    if negative || !lossless {
        return Err(invalid(format!("size of {} is not a u64", js.path)));
    }

    Ok(Entry {
        path: js.path,
        directory: js.directory,
        size,
        mtime_ms: js.mtime_ms,
    })
}

/// Blocks in `DoDragDrop` until the drop or cancel: "dropped", "cancelled" or "failed".
#[napi]
pub fn begin(options: BeginOptions<'_>) -> Result<String> {
    let window =
        window_handle(&options.hwnd).ok_or_else(|| invalid("hwnd must be 8 non-zero bytes"))?;
    let entries = options
        .entries
        .into_iter()
        .map(entry)
        .collect::<Result<Vec<_>>>()?;
    let events = JsEvents {
        contents: options
            .on_contents
            .build_threadsafe_function()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?,
        release: options
            .on_release
            .build_threadsafe_function()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?,
        operation_end: options
            .on_operation_end
            .build_threadsafe_function()
            .callee_handled::<false>()
            .weak::<true>()
            .build()?,
    };
    let image = Image {
        bgra: &options.image.bgra,
        width: options.image.width,
        height: options.image.height,
    };

    source::drag(&REGISTRY, window, entries, &image, Box::new(events))
        .map(|outcome| outcome.as_str().to_owned())
        .map_err(invalid)
}

/// The ticket's temp file is whole.
#[napi]
pub fn complete(ticket: u32, path: String) {
    REGISTRY.complete(ticket, PathBuf::from(path));
}

#[napi]
pub fn fail(ticket: u32) {
    REGISTRY.fail(ticket);
}

/// Quit: every waiting read fails and no new stream opens.
#[napi]
pub fn abort() {
    REGISTRY.abort_all();
}
