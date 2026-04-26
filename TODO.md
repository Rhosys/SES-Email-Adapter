# TODO

- [ ] Detect forwarded emails and auto-tag with the full source email address (e.g. `original:john@gmail.com`), where `john@gmail.com` is the original recipient address the email was sent to before being forwarded into the system. Use `X-Forwarded-To`, `X-Original-To`, or `Resent-To` headers to extract the address.
- [ ] API must return full DNS record list when user registers a domain (4 branded CNAMEs)
- [ ] Add `"set_urgency"` as a `RuleActionType` and `Arc.urgencyOverride` for user-configurable urgency overrides (deferred)
