// napi-build emits the link arguments a Node-API addon needs on the target (none for MSVC with dyn-symbols).
fn main() {
    napi_build::setup();
}
