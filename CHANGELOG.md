# Changelog

## [0.1.1](https://github.com/Sifat07/steadfast-merchant-sdk/compare/v0.1.0...v0.1.1) (2026-10-02)


### Bug Fixes

* don't echo customer data in validation errors ([fe745be](https://github.com/Sifat07/steadfast-merchant-sdk/commit/fe745be9bcee68a2f6df7e37584cc14adebe810d))
* one invalid order no longer fails a whole bulk request ([fc136df](https://github.com/Sifat07/steadfast-merchant-sdk/commit/fc136df31e8be6c3d8f939dc5456671950f4fe0b))
* resolve ./webhooks types under node10 moduleResolution ([9046ce4](https://github.com/Sifat07/steadfast-merchant-sdk/commit/9046ce44058842fb61848be5627f44c3ceb59217))

## 0.1.0 (2026-10-02)

- Docs: full README (lifecycle, per-method reference, errors, webhooks, what is verified), runnable `examples/`, CONTRIBUTING.
- First version: all 18 endpoints from the 2026 API guide, signed webhooks, typed errors.
- Bulk create retries once with JSON-encoded `data` if Steadfast answers 400 to the documented array form.
- Never follows redirects (keys are custom headers fetch would forward); a non-JSON 2xx is retryable; webhook statuses pass through unchanged; `X-Signature` verified when present, required only with `requireSignature`.
