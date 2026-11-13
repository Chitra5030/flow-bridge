const FLOW_HOSTS = ["flow.google.com", "labs.google"];
const attachedTabs = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isFlowUrl(url = "") {
  try {
    const host = new URL(url).hostname;
    return FLOW_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  } catch {
    return false;
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from Flow tab" });
    });
  });
}

function debuggerCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attachedTabs.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        attachedTabs.add(tabId);
        resolve();
      }
    });
  });
}

function detach(tabId) {
  return new Promise((resolve) => {
    if (!attachedTabs.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
      resolve();
    });
  });
}

async function submitPromptViaCdp(tabId, { inputPoint, text }) {
  await attach(tabId);

  // 1. Native click into prompt input box to focus
  if (inputPoint) {
    await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: inputPoint.x, y: inputPoint.y, buttons: 0
    });
    await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: inputPoint.x, y: inputPoint.y, button: "left", buttons: 1, clickCount: 1
    });
    await sleep(40);
    await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: inputPoint.x, y: inputPoint.y, button: "left", buttons: 0, clickCount: 1
    });
    await sleep(200);
  }

  // 2. Clear old text
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: "a", code: "KeyA", modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
  });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "a", code: "KeyA", modifiers: 2,
    windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
  });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8
  });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8
  });
  await sleep(100);

  // 3. Insert prompt text
  await debuggerCommand(tabId, "Input.insertText", { text });
  await sleep(400);

  // 4. Try Ctrl+Enter (multiline submit)
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2
  });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 2
  });
  await sleep(200);

  // 5. Try standard Enter
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13
  });
  await debuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13
  });
}

async function trustedClick(tabId, point) {
  await attach(tabId);
  await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x: point.x, y: point.y, buttons: 0
  });
  await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1
  });
  await sleep(40);
  await debuggerCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1
  });
}

async function activeFlowTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0] && isFlowUrl(tabs[0].url)) return tabs[0];
  const flowTabs = await chrome.tabs.query({ url: ["https://flow.google.com/*", "https://labs.google/*"] });
  return flowTabs.find((tab) => tab.id != null) || null;
}

async function ensureContent(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await sendToTab(tab.id, { type: "FLOW_STATUS" });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function saveDownload({ url, filename }) {
  const safe = String(filename || "flow-result").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const downloadId = await chrome.downloads.download({
    url,
    filename: `FlowBridge/${safe}`,
    conflictAction: "uniquify",
    saveAs: false
  });
  return { ok: true, downloadId };
}

chrome.action.onClicked.addListener(() => {
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_FLOW_STATUS") {
    activeFlowTab().then(async (tab) => {
      if (!tab) return sendResponse({ ok: true, connected: false, reason: "Open a Flow tab first" });
      const result = await ensureContent(tab);
      sendResponse({ ok: true, connected: result.ok !== false, tabId: tab.id, title: tab.title, reason: result.ok === false ? result.error : undefined });
    });
    return true;
  }

  if (message.type === "SUBMIT_PROMPT") {
    submitPromptViaCdp(message.tabId, {
      inputPoint: message.inputPoint,
      text: message.text
    })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "CLICK_BUTTON") {
    trustedClick(message.tabId, message.point)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "RUN_QUEUE") {
    (async () => {
      const tab = await activeFlowTab();
      if (!tab) return sendResponse({ ok: false, error: "Open a visible Google Flow tab first" });
      const status = await ensureContent(tab);
      if (status.ok === false) return sendResponse(status);
      const result = await sendToTab(tab.id, {
        type: "RUN_QUEUE",
        tabId: tab.id,
        mode: message.mode,
        prompts: message.prompts,
        delay: message.delay,
        outputPrefix: message.outputPrefix,
        referenceImages: message.referenceImages,
        characterName: message.characterName
      });
      await detach(tab.id);
      sendResponse(result);
    })();
    return true;
  }

  if (message.type === "STOP_QUEUE") {
    activeFlowTab().then((tab) => {
      if (!tab) return sendResponse({ ok: true });
      detach(tab.id);
      sendToTab(tab.id, { type: "STOP_QUEUE" }).then(sendResponse);
    });
    return true;
  }

  if (message.type === "DOWNLOAD_RESULT") {
    saveDownload(message).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "QUEUE_PROGRESS") {
    if (!message.forwarded) chrome.runtime.sendMessage({ ...message, forwarded: true }, () => void chrome.runtime.lastError);
    return false;
  }

  if (message.type === "DETACH") {
    detach(message.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.debugger.onDetach.addListener(({ tabId }) => attachedTabs.delete(tabId));


// ===============================================
// Agent Bridge Integration (Connects to Local Daemon Port 8791)
// ===============================================
let bridgeWs = null;
let heartbeatInterval = null;

function sendStatusUpdate() {
  if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
    bridgeWs.send(JSON.stringify({
      t: "ext.status",
      loggedIn: true,
      plan: "free",
      usedToday: 0,
      dailyLimit: 40,
      usage: { video: 0, image: 0 },
      limits: { video: 30, image: 40 },
      activeJobs: 0,
      flowVisible: true
    }));
  }
}

function connectAgentBridge() {
  try {
    bridgeWs = new WebSocket("ws://127.0.0.1:8791/ws");

    bridgeWs.onopen = () => {
      console.log("[Flow Bridge] Connected to Agent Bridge on 8791/ws");
      bridgeWs.send(JSON.stringify({
        t: "ext.hello",
        extVersion: "0.1.0",
        loggedIn: true,
        plan: "free",
        site: "flow",
        browser: "chrome",
        flowTab: true,
        flowVisible: true
      }));

      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
          bridgeWs.send(JSON.stringify({ t: "ext.heartbeat" }));
          sendStatusUpdate();
        }
      }, 10000);
    };

    bridgeWs.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg.t === "status.query") {
          sendStatusUpdate();
          return;
        }

        if (msg.t === "job.submit") {
          const jobId = msg.jobId;
          const prompt = msg.job?.prompt || "";
          bridgeWs.send(JSON.stringify({ t: "job.accepted", jobId }));
          bridgeWs.send(JSON.stringify({ t: "job.progress", jobId, stage: "generating" }));

          const tab = await activeFlowTab();
          if (!tab) {
            bridgeWs.send(JSON.stringify({ t: "job.failed", jobId, reason: "Google Flow tab not open", retryable: false }));
            return;
          }
          await ensureContent(tab);

          let prefix = "flow";
          const sceneMatch = prompt.match(/SCENE\s*(\d+)/i);
          if (sceneMatch) {
            prefix = `Scene-${sceneMatch[1]}`;
          }

          const isVideo = msg.job?.mode === "flow-text-to-video";

          const result = await sendToTab(tab.id, {
            type: "RUN_QUEUE",
            tabId: tab.id,
            mode: isVideo ? "video" : "image",
            prompts: [prompt],
            delay: 2500,
            outputPrefix: prefix
          });

          await detach(tab.id);

          if (result && result.ok && result.file) {
            bridgeWs.send(JSON.stringify({
              t: "job.result",
              jobId,
              files: [{ path: result.file, kind: isVideo ? "video" : "image" }]
            }));
          } else if (result && result.ok) {
            bridgeWs.send(JSON.stringify({
              t: "job.result",
              jobId,
              files: [{ path: `FlowBridge/${prefix}-001.${isVideo ? "mp4" : "png"}`, kind: isVideo ? "video" : "image" }]
            }));
          } else {
            bridgeWs.send(JSON.stringify({
              t: "job.failed",
              jobId,
              reason: result?.error || "Generation error",
              retryable: false
            }));
          }
          return;
        }
      } catch (e) {
        console.error("[Flow Bridge] Job error:", e);
      }
    };

    bridgeWs.onclose = () => {
      bridgeWs = null;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      setTimeout(connectAgentBridge, 3000);
    };

    bridgeWs.onerror = () => {};
  } catch (err) {
    setTimeout(connectAgentBridge, 3000);
  }
}

connectAgentBridge();
