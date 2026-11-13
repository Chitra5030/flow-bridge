(() => {
  let stopRequested = false;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function showStatus(text) {
    let b = document.getElementById("flow-bridge-status-banner");
    if (!b) {
      b = document.createElement("div");
      b.id = "flow-bridge-status-banner";
      b.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:999999;background:#10b981;color:#fff;font-family:sans-serif;font-size:14px;font-weight:bold;padding:10px 20px;border-radius:24px;box-shadow:0 4px 14px rgba(0,0,0,0.4);pointer-events:none;transition:all 0.3s;";
      document.body.appendChild(b);
    }
    b.textContent = text;
    b.style.display = "block";
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  function promptInput() {
    const candidates = [
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[data-slate-editor="true"]',
      'textarea[placeholder*="want to create" i]',
      'input[placeholder*="want to create" i]',
      'textarea',
      'input[type="text"]'
    ];
    for (const sel of candidates) {
      const all = [...document.querySelectorAll(sel)].filter(visible);
      if (all.length > 0) {
        const match = all[all.length - 1];
        if (!match.isContentEditable && !(match instanceof HTMLTextAreaElement) && !(match instanceof HTMLInputElement)) {
          const inner = match.querySelector('[contenteditable="true"], textarea, input');
          if (inner && visible(inner)) return inner;
        }
        return match;
      }
    }
    return null;
  }

  function buttonLabel(button) {
    return `${button.innerText || ""} ${button.getAttribute("aria-label") || ""} ${button.title || ""}`
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  function generateButton(input) {
    let parent = input;
    for (let i = 0; i < 8 && parent; i += 1, parent = parent.parentElement) {
      const buttons = [...parent.querySelectorAll("button,[role=button]")].filter(visible);
      if (!buttons.length) continue;
      // Look for the circular arrow or generate action button
      const match = buttons.find((button) => /send|create|generate|submit|arrow_forward|arrow_upward/.test(buttonLabel(button)));
      if (match) return match;
      return buttons[buttons.length - 1];
    }
    return [...document.querySelectorAll("button,[role=button]")]
      .filter(visible)
      .find((button) => /send|create|generate|submit|arrow_forward|arrow_upward/.test(buttonLabel(button)));
  }

  function fullClick(element) {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    element.dispatchEvent(new PointerEvent("pointerover", opts));
    element.dispatchEvent(new PointerEvent("pointerenter", opts));
    element.dispatchEvent(new PointerEvent("pointerdown", opts));
    element.dispatchEvent(new MouseEvent("mousedown", opts));
    element.dispatchEvent(new PointerEvent("pointerup", opts));
    element.dispatchEvent(new MouseEvent("mouseup", opts));
    element.dispatchEvent(new MouseEvent("click", opts));
  }

  function mediaSnapshot() {
    return new Set([
      ...[...document.querySelectorAll("main img, img[src*='googleusercontent'], img[src*='blob:']")].map((node) => node.currentSrc || node.src),
      ...[...document.querySelectorAll("main video, video[src]")].map((node) => node.currentSrc || node.src)
    ].filter(Boolean));
  }

  async function waitForMedia(previous, timeout = 180000, mode = "image") {
    const start = Date.now();
    showStatus("Flow Bridge: Generating in Google Flow...");
    while (!stopRequested && Date.now() - start < timeout) {
      await sleep(2000);
      if (mode === "video") {
        const videos = [...document.querySelectorAll("main video, video[src]")];
        const newVideo = videos.find((node) => {
          const src = node.currentSrc || node.src;
          return src && !previous.has(src);
        });
        if (newVideo) return newVideo;

        const playBtn = document.querySelector("main button[aria-label*='Play' i], main [role='button'][aria-label*='Play' i]");
        if (playBtn) playBtn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      } else {
        const media = [...document.querySelectorAll("main img, img[src*='googleusercontent'], img[src*='blob:']")];
        const newMedia = media.find((node) => {
          const src = node.currentSrc || node.src;
          return src && !previous.has(src) && ((node.naturalWidth || node.width || 0) >= 150);
        });
        if (newMedia) return newMedia;
      }
    }
    const all = [...document.querySelectorAll("main video, video[src], main img, img[src*='googleusercontent']")];
    return all.find((node) => (node.currentSrc || node.src) && !previous.has(node.currentSrc || node.src)) || null;
  }

  async function downloadMedia(node, filename) {
    showStatus("💾 Flow Bridge: Downloading result...");
    const src = node.currentSrc || node.src;
    if (!src) throw new Error("Generated media has no downloadable URL");
    let url = src;
    if (src.startsWith("blob:")) {
      const response = await fetch(src);
      const blob = await response.blob();
      url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
    const response = await new Promise((resolve) => chrome.runtime.sendMessage({
      type: "DOWNLOAD_RESULT", url, filename
    }, resolve));
    if (!response?.ok) throw new Error(response?.error || "Download failed");
    showStatus("✅ Flow Bridge: Download complete! (" + filename + ")");
    setTimeout(() => {
      const b = document.getElementById("flow-bridge-status-banner");
      if (b) b.style.display = "none";
    }, 6000);
    return `FlowBridge/${filename}`;
  }

  async function runQueue({ mode, prompts, delay, outputPrefix, tabId }) {
    stopRequested = false;
    if (!prompts?.length) return { ok: false, error: "Add at least one prompt" };
    
    showStatus("🚀 Flow Bridge: Finding prompt box...");
    const input = promptInput();
    if (!input) {
      showStatus("❌ Flow Bridge: Prompt box not found");
      return { ok: false, error: "Flow prompt box was not found" };
    }

    let lastSavedFile = null;

    for (let index = 0; index < prompts.length; index += 1) {
      if (stopRequested) break;
      const prompt = prompts[index];
      const before = mediaSnapshot();

            showStatus("Flow Bridge: Inserting prompt into Flow...");
      try {
        input.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false, null);
        document.execCommand("insertText", false, prompt);
        input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } catch (err) {
        console.warn("Direct insert error:", err);
      }

      const inRect = input.getBoundingClientRect();
      const inputPoint = { x: inRect.left + inRect.width / 2, y: inRect.top + inRect.height / 2 };
      await chrome.runtime.sendMessage({
        type: "SUBMIT_PROMPT",
        tabId: tabId || messageTabId,
        inputPoint,
        text: prompt
      }).catch(() => {});

      // Wait for layout to adjust with new multiline text height
      await sleep(500);

      // Now query generate button with FRESH coordinates
      showStatus("🚀 Flow Bridge: Clicking Generate (➔)...");
      const button = generateButton(input);
      if (button) {
        const bRect = button.getBoundingClientRect();
        const freshButtonPoint = { x: bRect.left + bRect.width / 2, y: bRect.top + bRect.height / 2 };
        await chrome.runtime.sendMessage({
          type: "CLICK_BUTTON",
          tabId: tabId || messageTabId,
          point: freshButtonPoint
        }).catch(() => {});

        fullClick(button);
        button.click();
      }

      const media = await waitForMedia(before, 180000, mode);
      if (!media) throw new Error("Timed out waiting for generation result");

      const extension = mode === "video" ? "mp4" : "png";
      const outName = `${outputPrefix || mode}-${String(index + 1).padStart(3, "0")}.${extension}`;
      lastSavedFile = await downloadMedia(media, outName);

      chrome.runtime.sendMessage({ type: "QUEUE_PROGRESS", mode, done: index + 1, total: prompts.length, current: prompt });
      if (index < prompts.length - 1) await sleep(Math.max(0, Number(delay) || 2500));
    }
    return { ok: true, stopped: stopRequested, file: lastSavedFile };
  }

  let messageTabId = null;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "FLOW_STATUS") {
      sendResponse({ ok: true, title: document.title });
      return false;
    }
    if (message.type === "STOP_QUEUE") {
      stopRequested = true;
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "RUN_QUEUE") {
      messageTabId = message.tabId || sender.tab?.id;
      runQueue({ ...message, tabId: messageTabId })
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    return false;
  });

  console.log("[Flow Bridge] Custom content script ready!");
})();
