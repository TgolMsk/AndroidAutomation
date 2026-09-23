# Visual advisor boundary

`AdvisorService` is a game-neutral, opt-in reader. Its only device dependency is
`AdvisorCapturePort`. The host must resolve a registered game and running AVD,
read the foreground package both before and after screenshot capture, and pass a
`RawFrame` with `capturedAt`. The service repeats the expected-package check
before a screenshot leaves the Mac. Renderer code never sends image bytes.

The provider contract is OpenAI-compatible `chat/completions` with one JPEG
image. HTTPS is required except for a loopback model. Redirects are rejected.
The API key is stored only in `~/.avdm/automation/advisor.json` with mode 0600;
the renderer receives a masked `AdvisorConfigView`. Records contain structured
advice and risk evidence but no screenshots or raw provider response. The
hourly request count and per-instance cooldown survive application restarts.

The local risk gate rejects unknown or non-low risks, listed hazards, missing
button/dialog/consequence evidence, low confidence, and action/effect mismatch.
Confirmations require at least 0.85 confidence and still remain manual. The
service has no tap, key or template-write interface. A safe close suggestion
can produce `AdvisorTemplateProposal`, which carries pixel coordinates and
source metadata. The template editor must take a **new** screenshot and have
the user review the crop before saving it.

The old panel's automatic unknown-screen recovery, click-time second opinion,
repeat-confirmation lock, post-click scene verification, and automatic template
harvest are deliberately absent. Those are device-writing flows and must be
reintroduced only through a separate verified executor, never through this
reader. Old `ai.json` credentials are not imported automatically.
