const $ = (id) => document.getElementById(id);

const state = {
  setupComplete: false,
  announcementVisible: true,
  imageCount: 0,
  videoCount: 0,
  queue: [],
  activeQueueIndexes: [],
  referenceImages: [],
  running: false,
  currentIndex: -1,
  connection: null
};

const setupMessage = (agent) => `Set up Flow Bridge for ${agent}.

Use the local Flow Bridge queue to create images and videos in the user's visible Google Flow tab. Keep the Flow tab open and visible while work runs. Do not ask for, read, or transmit Google passwords, cookies, access tokens, prompts, or generated media. Use the user's own account limits and stop when the user asks.

The extension is installed locally at flow-connector-mvp. Confirm the target Flow tab before sending a queue, then report each item and its local Downloads/FlowBridge filename.`;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

async function load() {
  const saved = await storageGet({
    flowBridge: {},
    dismissedAnnouncement: false
  });
  const persisted = saved.flowBridge || {};
  Object.assign(state, {
    setupComplete: !!persisted.setupComplete,
    announcementVisible: !saved.dismissedAnnouncement,
    imageCount: Number(persisted.imageCount) || 0,
    videoCount: Number(persisted.videoCount) || 0,
    queue: Array.isArray(persisted.queue) ? persisted.queue : []
  });
  render();
  await refreshConnection();
}

async function persist() {
  await storageSet({
    flowBridge: {
      setupComplete: state.setupComplete,
      imageCount: state.imageCount,
      videoCount: state.videoCount,
      queue: state.queue
    }
  });
}

function setActiveTab(name) {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === name));
  document.querySelectorAll(".view").forEach((view) => { view.hidden = view.dataset.view !== name; });
}

function render() {
  $("announcement").hidden = !state.announcementVisible;
  $("notSetupState").hidden = state.setupComplete;
  $("connectedState").hidden = !state.setupComplete;
  $("videoCount").textContent = state.videoCount;
  $("imageCount").textContent = state.imageCount;
  $("videoUsage").style.width = `${Math.min(100, state.videoCount / 30 * 100)}%`;
  $("imageUsage").style.width = `${Math.min(100, state.imageCount / 40 * 100)}%`;
  $("queueCount").textContent = `${state.queue.length} item${state.queue.length === 1 ? "" : "s"}`;
  $("startQueueButton").hidden = state.running;
  $("stopQueueButton").hidden = !state.running;
  $("addQueueButton").disabled = state.running;
  $("queueList").innerHTML = state.queue.length
    ? state.queue.map((item, index) => `<div class="queue-item ${item.state || "queued"}">
        <span class="number">${String(index + 1).padStart(2, "0")}</span>
        <span class="prompt">${escapeHtml(item.prompt)}</span>
        <span class="state">${item.state || "queued"}</span>
      </div>`).join("")
    : `<div class="queue-item"><span class="prompt">Your queue is empty.</span><span class="state">ready</span></div>`;
  const agent = $("agentSelect").value;
  $("setupPrompt").value = setupMessage(agent);
  $("referenceCount").textContent = `${state.referenceImages.length} selected`;
  $("characterNameRow").hidden = $("modeSelect").value !== "character";
  $("referencePreview").innerHTML = state.referenceImages.map((image) => `<img src="${image.dataUrl}" alt="${escapeHtml(image.name)}" title="${escapeHtml(image.name)}">`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

async function refreshConnection() {
  if (!state.setupComplete) return;
  const response = await send({ type: "GET_FLOW_STATUS" });
  state.connection = response?.connected ? response : null;
  $("connectionPill").textContent = state.connection ? "Flow connected" : "Flow offline";
  $("connectionPill").classList.toggle("offline", !state.connection);
  $("flowWarning").hidden = !!state.connection;
  if (!state.connection) {
    $("flowWarning").textContent = response?.reason || response?.error || "Open the active Google Flow tab and press refresh.";
  }
}

function addPrompts() {
  const input = $("promptInput");
  const prompts = input.value.split(/\r?\n/).map((prompt) => prompt.trim()).filter(Boolean);
  if (!prompts.length) return;
  state.queue.push(...prompts.map((prompt) => ({ prompt, state: "queued" })));
  input.value = "";
  $("queueStatus").textContent = "Ready";
  persist();
  render();
}

function readReferenceFiles(files) {
  return Promise.all([...files].map((file) => new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error(`${file.name} is not an image`));
    if (file.size > 8 * 1024 * 1024) return reject(new Error(`${file.name} is larger than 8 MB`));
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  })));
}

async function updateReferenceImages(event) {
  try {
    state.referenceImages = await readReferenceFiles(event.target.files);
    $("queueStatus").textContent = state.referenceImages.length ? "References ready" : "Ready";
  } catch (error) {
    state.referenceImages = [];
    $("queueStatus").textContent = error.message;
  }
  render();
}

async function startQueue() {
  if (!state.queue.some((item) => item.state !== "done")) addPrompts();
  const pending = state.queue.map((item, index) => ({ item, index })).filter(({ item }) => item.state !== "done");
  if (!pending.length) {
    $("queueStatus").textContent = "Add a prompt first";
    return;
  }
  const connection = await send({ type: "GET_FLOW_STATUS" });
  if (!connection?.connected) {
    state.connection = null;
    $("connectionPill").textContent = "Flow offline";
    $("connectionPill").classList.add("offline");
    $("flowWarning").hidden = false;
    $("queueStatus").textContent = "Open Flow first";
    return;
  }

  const mode = $("modeSelect").value;
  if (mode === "character" && !state.referenceImages.length) {
    $("queueStatus").textContent = "Character mode needs a reference image";
    return;
  }

  state.connection = connection;
  state.running = true;
  state.activeQueueIndexes = pending.map(({ index }) => index);
  state.currentIndex = -1;
  pending.forEach(({ item }) => { item.state = "queued"; });
  $("queueStatus").textContent = "Running";
  render();
  const response = await send({
    type: "RUN_QUEUE",
    mode,
    prompts: pending.map(({ item }) => item.prompt),
    delay: Number($("delaySelect").value),
    outputPrefix: $("prefixInput").value.trim() || "flow",
    referenceImages: state.referenceImages,
    characterName: $("characterName").value.trim()
  });
  state.running = false;
  if (response?.ok) {
    if (!response.stopped) state.activeQueueIndexes.forEach((index) => { state.queue[index].state = "done"; });
    else state.activeQueueIndexes.forEach((index) => { if (state.queue[index].state === "running") state.queue[index].state = "queued"; });
    $("queueStatus").textContent = response.stopped ? "Paused" : "Complete";
  } else {
    const current = state.queue[state.currentIndex];
    if (current && current.state === "running") current.state = "failed";
    $("queueStatus").textContent = response?.error || "Queue failed";
  }
  await persist();
  render();
}

async function stopQueue() {
  await send({ type: "STOP_QUEUE" });
  state.running = false;
  $("queueStatus").textContent = "Stopping…";
  render();
}

function copySetup() {
  navigator.clipboard.writeText($("setupPrompt").value).then(() => {
    $("copyStatus").textContent = "Setup message copied.";
  }).catch(() => {
    $("setupPrompt").select();
    document.execCommand("copy");
    $("copyStatus").textContent = "Setup message copied.";
  });
}

function finishSetup() {
  state.setupComplete = true;
  persist();
  setActiveTab("home");
  render();
  refreshConnection();
}

document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab)));
$("finishSetupButton").addEventListener("click", () => { setActiveTab("setup"); });
$("markSetupButton").addEventListener("click", finishSetup);
$("copySetupButton").addEventListener("click", copySetup);
$("agentSelect").addEventListener("change", render);
$("modeSelect").addEventListener("change", render);
$("referenceFiles").addEventListener("change", updateReferenceImages);
$("addQueueButton").addEventListener("click", addPrompts);
$("startQueueButton").addEventListener("click", startQueue);
$("stopQueueButton").addEventListener("click", stopQueue);
$("refreshConnectionButton").addEventListener("click", refreshConnection);
$("clearQueueButton").addEventListener("click", async () => {
  if (state.running) return;
  state.queue = [];
  state.activeQueueIndexes = [];
  $("queueStatus").textContent = "Ready";
  await persist();
  render();
});
$("dismissAnnouncement").addEventListener("click", async () => {
  state.announcementVisible = false;
  $("announcement").hidden = true;
  await storageSet({ dismissedAnnouncement: true });
});
$("closeButton").addEventListener("click", () => window.close());
$("pinButton").addEventListener("click", () => {
  $("copyStatus").textContent = "Keep this panel open while a queue is running.";
});
$("signInButton").addEventListener("click", () => {
  setActiveTab("setup");
  $("copyStatus").textContent = "Sign in to Google Flow in its browser tab; this panel never asks for your password.";
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "QUEUE_PROGRESS") return;
  const activeIndex = Number(message.done) - 1;
  const index = state.activeQueueIndexes[activeIndex];
  if (state.queue[index]) state.queue[index].state = "done";
  state.currentIndex = activeIndex + 1;
  if (message.mode === "video") state.videoCount += 1;
  else state.imageCount += 1;
  const nextIndex = state.activeQueueIndexes[state.currentIndex];
  if (state.queue[nextIndex]) state.queue[nextIndex].state = "running";
  $("queueStatus").textContent = `${message.done}/${message.total} complete`;
  persist();
  render();
});

load();


