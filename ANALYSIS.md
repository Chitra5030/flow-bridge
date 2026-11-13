# Flow Connector analysis

## Product shape

The reference is a Chrome Manifest V3 side-panel product for Google Flow. The
panel is a control surface; generation happens in the user's visible, signed-in
Flow tab.

### Visible UI from the supplied screenshot

- Compact dark panel with a green-tinted announcement card.
- Header: product mark, title, pin/keep-open control, close control.
- Three tabs: **Home**, **Setup**, and **Help**.
- First-run Home state: terminal icon, “Not set up yet”, setup CTA.
- Free-plan card with sign-in CTA and separate video/image allowance bars.
- The screenshot announcement calls out play/pause, clear queue, and 2K/1080p
  upscale support.

### Public product behavior

The public product page and store listing describe:

- Prompt queues for text-to-image and text-to-video.
- First/last frame, ingredients/reference assets, video-to-video, characters,
  voice, clip extension, and clip merging.
- Automatic downloads with readable filenames.
- A local browser connection using the user's own Google Flow account; no API
  key and no server-side prompt/media processing.
- A Claude Code skill and a standard MCP connection for other coding agents.
- A free daily allowance (30 videos / 40 images in the observed listing) and a
  paid faster/unlimited tier.
- The Flow tab must remain visible while automation runs.

## Reconstructed architecture

```text
Side panel UI
   │ chrome.runtime messages
Service worker ── storage / queue state / downloads / tab lookup
   │
Content script on visible Flow tab
   └─ finds prompt editor, submits prompt, waits for new media
```

The reference uses trusted browser input for Flow's script-resistant generate
control. The MVP follows that pattern only for the active Flow tab and does not
inspect or export credentials. Debugger attachment is short-lived and is
detached after each trusted input/click operation.

## MVP delivered here

- Screenshot-inspired Home/Setup/Help UI.
- Persistent setup state, announcement dismissal, queue, usage counters.
- Active Flow-tab detection and content-script injection for already-open tabs.
- Image/video queue with start/stop, progress, timeout handling, and retry-free
  clear errors.
- Reference-image attachment for image/video prompts and a character mode that
  selects Flow's character UI, uploads references, and optionally fills a name.
- Local downloads under `Downloads/FlowBridge/`.
- Setup message that can be copied to a coding agent without requesting secrets.

## Deliberate next-stage work

The production version still needs an independently audited local MCP/CLI
helper, account/licence UX, richer Flow mode controls, pause/resume checkpoints,
result history, and UI selectors maintained against the current Flow interface.
Those pieces should be added without token capture, credential storage, or
server-side media proxying.
