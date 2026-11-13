# Flow Bridge MVP

Chrome MV3 side-panel prototype inspired by the visible Flow Connector workflow.

## What is included

- Dark side panel with Home / Setup / Help tabs.
- Local setup state and prompt queue persistence through `chrome.storage.local`.
- Flow-tab detection for `flow.google.com` and `labs.google`.
- Queue start/stop controls, progress, logs, and local Downloads/FlowBridge output.
- Content-script bridge that finds the visible Flow prompt editor and generate button.
- Trusted input/click support through `chrome.debugger`; it attaches only to the active Flow tab and detaches when Chrome does.
- Multiple reference-image selection for queued prompts.
- Character mode with a reference image and optional character name.

## Load locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `flow-connector-mvp` folder.
5. Open a signed-in Google Flow tab, then open the extension side panel.

## Reference images and character mode

1. In Home, choose **Images**, **Videos**, or **Character**.
2. Select one or more local reference images. They are kept in the side-panel
   session and converted to browser-local data only for the active queue.
3. For **Character**, provide at least one reference image and optionally a
   character name. The content script selects a matching Flow mode, attaches the
   files through Flow's visible upload input, then submits the prompts.

Flow's DOM and labels can change. If the upload control is not found, refresh
the Flow tab and inspect/update the generic selectors in `content.js`.

## Scope

This is an independent implementation and is not affiliated with Google or the
Flow Connector publisher. It does not read or transmit Google access tokens,
passwords, prompts, or generated media to a server. The queue uses the visible
Flow page and the user's own account; Flow limits and terms still apply.

The coding-agent/MCP setup screen is intentionally a local setup prompt in this
MVP. A production agent bridge would be a separately audited local helper using
the same queue message contract; credentials should never be copied into the
extension.
