# Changelog

## 0.1.0 (unreleased)

- Docs: full README (lifecycle, per-method reference, errors, webhooks, what is verified), runnable `examples/`, CONTRIBUTING.
- First version: all 18 endpoints from the 2026 API guide, signed webhooks, typed errors.
- Bulk create retries once with JSON-encoded `data` if Steadfast answers 400 to the documented array form.
- Never follows redirects (keys are custom headers fetch would forward); a non-JSON 2xx is retryable; webhook statuses pass through unchanged; `X-Signature` verified when present, required only with `requireSignature`.
