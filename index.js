import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm";

const MODEL = "claude-opus-5-5";
const API_KEY_STORAGE = "anthropic_api_key";
const MAX_IMAGE_EDGE = 1568;
const MAX_CONTINUATIONS = 4;
const FEE_RATE = 0.1;

const $ = (id) => document.getElementById(id);

const SYSTEM_PROMPT = `あなたは日本のフリマ・オークション相場に詳しい査定の専門家です。
ユーザーが撮影した商品の写真から商品を特定し、メルカリとヤフオク!で実際に「売れた」価格を web 検索で調べ、売値を推定してください。

手順:
1. 写真からブランド・商品名・型番・色・サイズ・状態を読み取る。箱やタグの文字も手がかりにする。
2. web_search で「売り切れ」「落札」「相場」など実際の取引価格がわかる情報を中心に調べる（メルカリの売り切れ商品、ヤフオクの落札相場、オークファン、価格比較サイトなど）。出品中の価格より成約価格を重視する。
3. 状態（写真とユーザーの補足から判断）を考慮して、各サービスでの価格帯・中央値・推奨価格を決める。
4. 確信が持てない場合は confidence を下げ、notes に理由を書く。

最後に、次の JSON だけを \`\`\`json コードブロックで出力してください。価格はすべて日本円の整数、不明な値は null。
{
  "product": {
    "name": "商品名（ブランド含む）",
    "brand": "ブランド",
    "model": "型番など",
    "category": "カテゴリ",
    "condition": "推定される状態"
  },
  "search_keyword": "メルカリ/ヤフオクで検索するときに最適なキーワード",
  "mercari": { "low": 0, "median": 0, "high": 0, "recommended": 0 },
  "yahoo_auction": { "low": 0, "median": 0, "high": 0, "recommended": 0 },
  "confidence": "high | medium | low",
  "advice": "どちらで売るのがおすすめか、出品のコツ（2〜3文）",
  "notes": ["相場に影響する要素や注意点"],
  "sources": [{ "title": "ページタイトル", "url": "https://..." }]
}`;

let selectedFile = null;

// ---- 設定 ----
function loadApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function saveApiKey(key) {
  try {
    localStorage.setItem(API_KEY_STORAGE, key);
  } catch {
    // ストレージが使えない環境ではセッション中のみ保持
  }
}

$("api-key").value = loadApiKey();
if (!loadApiKey()) $("settings").open = true;

$("save-key").addEventListener("click", () => {
  saveApiKey($("api-key").value.trim());
  $("settings").open = false;
  updateAnalyzeButton();
});

// ---- 写真選択 ----
$("photo").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  selectedFile = file;
  const preview = $("preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  $("photo-placeholder").hidden = true;
  updateAnalyzeButton();
});

function updateAnalyzeButton() {
  $("analyze").disabled = !selectedFile;
}

// 画像を API の推奨サイズに縮小して base64 JPEG にする
async function fileToBase64Jpeg(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

// ---- 表示まわり ----
function logStatus(text) {
  const li = document.createElement("li");
  li.textContent = text;
  $("status-log").appendChild(li);
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

const yen = (n) => (typeof n === "number" && Number.isFinite(n) ? `¥${Math.round(n).toLocaleString("ja-JP")}` : "—");
const range = (p) => (p && (p.low != null || p.high != null) ? `${yen(p.low)} 〜 ${yen(p.high)}` : "—");
const net = (n) => (typeof n === "number" ? yen(n * (1 - FEE_RATE)) : "—");

const CONFIDENCE_LABEL = { high: "確度: 高", medium: "確度: 中", low: "確度: 低" };

function renderResult(data, fallbackSources) {
  const p = data.product || {};
  $("product-name").textContent = p.name || "商品を特定できませんでした";
  $("product-detail").textContent = [p.brand, p.model, p.category, p.condition && `状態: ${p.condition}`]
    .filter(Boolean)
    .join(" / ");
  $("confidence").textContent = CONFIDENCE_LABEL[data.confidence] || "確度: 不明";

  const m = data.mercari || {};
  $("mercari-recommended").textContent = yen(m.recommended);
  $("mercari-range").textContent = range(m);
  $("mercari-median").textContent = yen(m.median);
  $("mercari-net").textContent = net(m.recommended);

  const y = data.yahoo_auction || {};
  $("yahoo-recommended").textContent = yen(y.recommended);
  $("yahoo-range").textContent = range(y);
  $("yahoo-median").textContent = yen(y.median);
  $("yahoo-net").textContent = net(y.recommended);

  const keyword = data.search_keyword || p.name || "";
  const q = encodeURIComponent(keyword);
  $("mercari-link").href = `https://jp.mercari.com/search?keyword=${q}&status=sold_out`;
  $("yahoo-link").href = `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${q}`;

  $("advice").textContent = data.advice || "";

  const notes = $("notes");
  notes.replaceChildren();
  for (const note of data.notes || []) {
    const li = document.createElement("li");
    li.textContent = note;
    notes.appendChild(li);
  }

  const sources = $("sources");
  sources.replaceChildren();
  const list = data.sources?.length ? data.sources : fallbackSources;
  for (const s of list.slice(0, 8)) {
    if (!s?.url || !/^https?:\/\//.test(s.url)) continue;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.title || s.url;
    li.appendChild(a);
    sources.appendChild(li);
  }

  $("result").hidden = false;
  $("result").scrollIntoView({ behavior: "smooth" });
}

function extractJson(text) {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const candidate = fenced.length ? fenced[fenced.length - 1][1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

// ---- Claude 呼び出し ----
async function analyze() {
  const apiKey = $("api-key").value.trim() || loadApiKey();
  if (!apiKey) {
    $("settings").open = true;
    showError("先に Anthropic API キーを設定してください。");
    return;
  }

  $("analyze").disabled = true;
  $("error").hidden = true;
  $("result").hidden = true;
  $("status-log").replaceChildren();
  $("status").hidden = false;

  try {
    logStatus("画像を準備中…");
    const imageData = await fileToBase64Jpeg(selectedFile);

    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const memo = $("memo").value.trim();
    const today = new Date().toLocaleDateString("ja-JP");

    /** @type {import("@anthropic-ai/sdk").default.Beta.Messages.BetaMessageParam[]} */
    const messages = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageData } },
          {
            type: "text",
            text: `今日は${today}です。この商品がメルカリとヤフオク!でいくらで売れるか調べてください。${memo ? `\n補足: ${memo}` : ""}`,
          },
        ],
      },
    ];

    logStatus("AI が商品を特定しています…");
    const sourceMap = new Map();
    let response;

    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8, user_location: { type: "approximate", country: "JP" } }],
        messages,
      });

      stream.on("contentBlock", (block) => {
        if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
          logStatus(`検索中: ${block.input.query}`);
        }
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.url && !sourceMap.has(r.url)) sourceMap.set(r.url, { title: r.title, url: r.url });
          }
        }
      });

      response = await stream.finalMessage();

      // 長いサーバーツール処理で一時停止した場合は続きをリクエストする
      if (response.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: response.content });
    }

    if (response.stop_reason === "refusal") {
      throw new Error("この画像は査定できませんでした（リクエストが拒否されました）。別の写真でお試しください。");
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let data;
    try {
      data = extractJson(text);
    } catch {
      throw new Error(`結果を読み取れませんでした。もう一度お試しください。\n\n${text.slice(0, 500)}`);
    }

    logStatus("完了");
    renderResult(data, [...sourceMap.values()]);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      showError("API キーが正しくありません。設定を確認してください。");
      $("settings").open = true;
    } else if (err instanceof Anthropic.RateLimitError) {
      showError("リクエストが多すぎます。少し待ってから再度お試しください。");
    } else if (err instanceof Anthropic.APIConnectionError) {
      showError("ネットワークに接続できませんでした。通信環境を確認してください。");
    } else if (err instanceof Anthropic.APIError) {
      showError(`API エラー (${err.status ?? "?"}): ${err.message}`);
    } else {
      showError(err?.message || String(err));
    }
  } finally {
    $("status").hidden = true;
    updateAnalyzeButton();
  }
}

$("analyze").addEventListener("click", analyze);
