/**
 * app.js — 前端純 JS 聊天室邏輯（無框架）
 * ---------------------------------------------------------
 * 功能重點：
 * 1) 基本訊息串接與渲染（使用者/機器人）
 * 2) 免登入多使用者：以 localStorage 建立 clientId
 * 3) 思考中動畫控制（輸入禁用/解禁）
 * 4) 呼叫後端 /api/chat，強化回應解析與錯誤處理
 * 5) ★ 新增：當回傳物件為 {} 時，顯示「網路不穩定，請再試一次」
 *
 * 依賴：
 * - 頁面需有以下元素：
 *   #messages, #txtInput, #btnSend, #thinking
 *
 * 注意：
 * - 本檔案為單純前端邏輯，不含任何打包或框架語法。
 */

"use strict";

/* =========================
   後端 API 網域（可依環境調整）
   ========================= */
const API_BASE = "https://taipei-marathon-server.onrender.com";
const api = (p) => `${API_BASE}${p}`;

/* =========================
   免登入多使用者：clientId
   - 以 localStorage 永續化
   - 預設使用 crypto.randomUUID()，若不支援則以時間戳+隨機碼
   ========================= */
const CID_KEY = "fourleaf_client_id";
let clientId = localStorage.getItem(CID_KEY);
if (!clientId) {
  clientId =
    (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CID_KEY, clientId);
}

/* =========================
   DOM 參照
   ========================= */
const elMessages = document.getElementById("messages");
const elInput = document.getElementById("txtInput");
const elBtnSend = document.getElementById("btnSend");
const elThinking = document.getElementById("thinking"); // ★ 思考動畫容器（如 spinner）

/* =========================
   訊息狀態（簡易記憶體）
   - 格式：{ id, role, text, ts }
   - role 僅為 'user' | 'assistant'
   ========================= */
/** @type {{id:string, role:'user'|'assistant', text:string, ts:number}[]} */
const messages = [];

/* =========================
   小工具
   ========================= */
const uid = () => Math.random().toString(36).slice(2);
function scrollToBottom() {
  // 使用 smooth 行為讓滾動自然
  elMessages?.scrollTo({ top: elMessages.scrollHeight, behavior: "smooth" });
}

/**
 * 切換「思考中」動畫與輸入狀態
 * - on=true：顯示思考動畫、禁用輸入與送出按鈕
 * - on=false：關閉動畫、恢復輸入
 */
function setThinking(on) {
  if (!elThinking) return;
  if (on) {
    elThinking.classList.remove("hidden");
    if (elBtnSend) elBtnSend.disabled = true;
    if (elInput) elInput.disabled = true;
  } else {
    elThinking.classList.add("hidden");
    if (elBtnSend) elBtnSend.disabled = false;
    if (elInput) elInput.disabled = false;
    // 解除禁用後讓輸入框自動聚焦
    elInput?.focus();
  }
}

/* =========================
   將 messages 渲染到畫面（移除語音播放按鈕）
   ========================= */
function render() {
  if (!elMessages) return;
  elMessages.innerHTML = "";

  for (const m of messages) {
    const isUser = m.role === "user";

    // 外層一列
    const row = document.createElement("div");
    row.className = `msg ${isUser ? "user" : "bot"}`;

    // 頭像
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = isUser
      ? 'https://raw.githubusercontent.com/justin-321-hub/taipei_marathon/refs/heads/main/assets/user-avatar.png'
      : 'https://raw.githubusercontent.com/justin-321-hub/taipei_marathon/refs/heads/main/assets/logo.png';
    avatar.alt = isUser ? "you" : "bot";

    // 對話泡泡
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerText = m.text;

    // 組合
    row.appendChild(avatar);
    row.appendChild(bubble);
    elMessages.appendChild(row);
  }

  scrollToBottom();
}

/* =========================
   呼叫後端，並顯示雙方訊息
   - 入口：sendText(text?)
   - 若無 text 參數，則取 input 欄位的值
   ========================= */
async function sendText(text) {
  const content = (text ?? elInput?.value ?? "").trim();
  if (!content) return;

  // 先插入使用者訊息到畫面
  const userMsg = { id: uid(), role: "user", text: content, ts: Date.now() };
  messages.push(userMsg);
  if (elInput) elInput.value = "";
  render();

  // 進入思考中（直到收到回覆才關閉）
  setThinking(true);

  try {
    // 呼叫後端 /api/chat
    const res = await fetch(api("/api/chat"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Id": clientId,
      },
      body: JSON.stringify({ text: content, clientId , language: "日文"}),
    });

    // 以文字讀回（避免直接 .json() 遇到空字串拋錯）
    const raw = await res.text();

    // 嘗試 JSON 解析；若 raw 為空字串，視為 {}
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      // 若 JSON 解析失敗，保留原始字串於 errorRaw 便於除錯
      data = { errorRaw: raw };
    }

    // HTTP 狀態非 2xx 時，直接丟錯
    if (!res.ok) {
      // ★ 新增：特別處理 502 / 404
      if (res.status === 502 || res.status === 404) {
        throw new Error("ネットワークが不安定です。もう一度お試しください。");
      }

      // 優先使用後端提供的錯誤訊息欄位
      const serverMsg =
        (data && (data.error || data.body || data.message)) ?? raw ?? "unknown error";
      throw new Error(`HTTP ${res.status} ${res.statusText} — ${serverMsg}`);
    }

    /**
     * ★ 關鍵：整理機器人要顯示的文字
     * 規則：
     * 1) 若 data 是字串，直接當回覆
     * 2) 若 data 是物件，優先用 data.text 或 data.message
     * 3) 若是空物件 {} → 顯示「網路不穩定，請再試一次」
     * 4) 其他物件 → JSON 字串化後顯示（利於除錯）
     */
    let replyText;
    if (typeof data === "string") {
      replyText = data.trim() || "（空白回覆）";
    } else if (data && (data.text || data.message)) {
      replyText = String(data.text || data.message);
    } else {
      // data 不是字串，也沒有 text/message 欄位
      const isPlainEmptyObject =
        data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        Object.keys(data).length === 0;

      replyText = isPlainEmptyObject
        ? "ネットワークが不安定です。もう一度お試しください。" // ★ 新增規則
        : JSON.stringify(data, null, 2); // 顯示完整物件，便於除錯
    }

    // 推入機器人訊息
    const botMsg = { id: uid(), role: "assistant", text: replyText, ts: Date.now() };
    messages.push(botMsg);

    // 關閉思考中 → 再渲染
    setThinking(false);
    render();
  } catch (err) {
    // 發生錯誤時也要關閉思考動畫
    setThinking(false);

    // 統一錯誤訊息格式
    const friendly =
      // 若使用者裝置離線，提供更直覺提示
      (!navigator.onLine && "現在オフラインです。ネットワーク接続を確認してもう一度お試しください。") ||
      // 其他錯誤，帶上簡短錯誤說明
      `${err?.message || err}`;//取得回覆時發生錯誤：

    const botErr = {
      id: uid(),
      role: "assistant",
      text: friendly,
      ts: Date.now(),
    };
    messages.push(botErr);
    render();
  }
}

/* =========================
   事件綁定（移除語音錄製事件）
   ========================= */

// 按鈕點擊送出
elBtnSend?.addEventListener("click", () => sendText());

// Enter 送出（Shift+Enter 換行）
elInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault(); // 防止換行
    sendText();
  }
});

// 頁面載入完成後讓輸入框聚焦（可選）
window.addEventListener("load", () => elInput?.focus());

/* =========================
   初始化歡迎訊息（移除語音提示）
   ========================= */
messages.push({
  id: uid(),
  role: "assistant",
  text:
    "臺北マラソンスマートカスタマーサービスへようこそ！アシスタントがいつでもお客様のご質問にお答えします。何かご不明な点がございましたら、お気軽にお問い合わせください。",
  ts: Date.now(),
});
render();



