import { useState, useEffect, useRef, useMemo } from "react";
import {
  Calendar, Camera, Train, LayoutGrid, Smartphone, Monitor,
  Plus, X, MapPin, ArrowRight, Trash2, ChevronLeft, ChevronRight,
  Check, Loader2, Clock, Home, Pencil, Image as ImageIcon,
  Bell, BellOff, BellRing, Volume2, VolumeX, CalendarPlus,
  Save, Star, Repeat, Bus, Navigation, RefreshCw, Moon, Cloud, CloudOff,
  Sun, CloudRain, CloudSnow, CloudLightning, CloudFog, CloudDrizzle,
  LogIn, LogOut, UserPlus,
} from "lucide-react";

/* ============================================================
   Supabase 設定  ← ここに自分のプロジェクトの値を入れてください
   （Supabase → Project Settings → API で確認）
   ============================================================ */
const SUPABASE_URL = "https://qyrmhpehrsurzskmvppn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_JhpfS3QiuSyVGlAkttrE9g_Z83EOAV7";
const SB_CONFIGURED =
  /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) &&
  !!SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith("YOUR");

/* localStorage（未対応環境では黙って無効化） */
const safeLS = {
  get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { window.localStorage.removeItem(k); } catch (e) {} },
};

/* 認証（GoTrue REST を fetch で直接叩く：SDK不要） */
async function sbAuth(path, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.msg || data.message || "認証に失敗しました");
  return data;
}
const sbSignUp = (email, password) => sbAuth("signup", { email, password });
const sbSignIn = (email, password) => sbAuth("token?grant_type=password", { email, password });
const sbRefresh = (refresh_token) => sbAuth("token?grant_type=refresh_token", { refresh_token });

/* データ（PostgREST：portals テーブルに1ユーザー1行の JSON を保存） */
async function sbLoad(session) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/portals?user_id=eq.${session.user.id}&select=data`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}` },
  });
  if (r.status === 401) throw new Error("401");
  if (!r.ok) throw new Error("load");
  const rows = await r.json();
  return rows[0] ? rows[0].data : null;
}
async function sbSave(session, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/portals`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ user_id: session.user.id, data, updated_at: new Date().toISOString() }),
  });
  if (r.status === 401) throw new Error("401");
  if (!r.ok) throw new Error("save");
}


/* ============================================================
   SONAR — じぶんポータル
   ・専用カレンダー
   ・写真から予定を自動追加（Claudeで画像解析）
   ・間に合うための乗換案内（出発ゲート）
   ・他アプリのショートカット
   ・スマホ / パソコン モード切替
   ============================================================ */

const BUFFER_MIN = 10; // 準備・徒歩などのバッファ

/* ---------- 日付ユーティリティ ---------- */
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(y, m - 1, dd);
};
const eventStart = (ev) => {
  if (!ev.date || !ev.start) return null;
  const [y, m, dd] = ev.date.split("-").map(Number);
  const [hh, mm] = ev.start.split(":").map(Number);
  return new Date(y, m - 1, dd, hh, mm);
};
const fmtClock = (d) =>
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const WD = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------- 繰り返し（recurrence） ---------- */
const REPEAT_OPTIONS = [
  { v: "none", label: "繰り返さない" },
  { v: "daily", label: "毎日" },
  { v: "weekly", label: "毎週" },
  { v: "monthly", label: "毎月" },
  { v: "yearly", label: "毎年" },
];
const REPEAT_LABEL = { daily: "毎日", weekly: "毎週", monthly: "毎月", yearly: "毎年" };
const RRULE_FREQ = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };
const stripTime = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/* ある日付 d に予定 ev が発生するか（アンカー日以降・除外日を考慮） */
function matchesRepeat(ev, d) {
  if (!ev.date) return false;
  const anchor = stripTime(parseYmd(ev.date));
  const day = stripTime(d);
  if (day < anchor) return false;
  const rep = ev.repeat || "none";
  let hit;
  if (rep === "none") hit = day.getTime() === anchor.getTime();
  else if (rep === "daily") hit = true;
  else if (rep === "weekly") hit = day.getDay() === anchor.getDay();
  else if (rep === "monthly") hit = day.getDate() === anchor.getDate();
  else if (rep === "yearly") hit = day.getDate() === anchor.getDate() && day.getMonth() === anchor.getMonth();
  else hit = false;
  if (!hit) return false;
  if (Array.isArray(ev.exdates) && ev.exdates.includes(ymd(day))) return false; // この日だけ削除
  return true;
}
const occursOn = (ev, dateStr) => matchesRepeat(ev, parseYmd(dateStr));

/* now 以降で次に開始する発生日時（無ければ null）。繰り返しを考慮 */
function nextOccurrence(ev, now) {
  if (!ev.start) return null;
  const [hh, mm] = ev.start.split(":").map(Number);
  const rep = ev.repeat || "none";
  if (rep === "none") {
    const s = eventStart(ev);
    return s && s.getTime() > now.getTime() ? s : null;
  }
  const anchor = stripTime(parseYmd(ev.date));
  let d = stripTime(now).getTime() > anchor.getTime() ? stripTime(now) : anchor;
  for (let i = 0; i < 430; i++) {
    if (matchesRepeat(ev, d)) {
      const dt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
      if (dt.getTime() > now.getTime()) return dt;
    }
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return null;
}

/* 指定した年月にこの予定の発生があるか */
function hasOccurrenceInMonth(ev, y, m) {
  if (!ev.date) return false;
  const rep = ev.repeat || "none";
  const anchor = stripTime(parseYmd(ev.date));
  const monthEnd = new Date(y, m + 1, 0);
  if (anchor.getTime() > monthEnd.getTime()) return false;
  if (rep === "none") return anchor.getFullYear() === y && anchor.getMonth() === m;
  for (let d = 1; d <= monthEnd.getDate(); d++) {
    if (matchesRepeat(ev, new Date(y, m, d))) return true;
  }
  return false;
}

function leaveInfo(ev, now) {
  const start = eventStart(ev);
  if (!start || now > start) {
    if (start && now > start) return { start, level: "done", label: "開始済み" };
    return null;
  }
  const travel = Number(ev.travelMin) || 0;
  const leave = new Date(start.getTime() - (travel + BUFFER_MIN) * 60000);
  const minToLeave = Math.round((leave - now) / 60000);
  let level, label;
  if (leave - now <= 0) { level = "rush"; label = "いますぐ出発"; }
  else if (minToLeave <= 15) { level = "rush"; label = "もうすぐ出発"; }
  else if (minToLeave <= 40) { level = "soon"; label = "そろそろ準備"; }
  else { level = "go"; label = "まだ余裕あり"; }
  return { start, leave, minToLeave, level, label };
}

/* ---------- 乗換案内リンク ---------- */
const gmapsUrl = (from, to) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;
const yahooUrl = (from, to) =>
  `https://transit.yahoo.co.jp/search/result?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

/* ---------- 画像から予定を抽出（Claude API） ---------- */
async function extractEventsFromImage(base64, mediaType) {
  const prompt =
    "この画像はチラシ・チケット・案内・スクリーンショットなど予定に関するものです。" +
    "含まれる予定を抽出してJSON配列だけを返してください。前置き・説明・Markdownは一切不要。" +
    '各要素の形式: {"title": string, "date": "YYYY-MM-DD"|null, "start": "HH:MM"|null, ' +
    '"end": "HH:MM"|null, "location": string|null, "notes": string|null}。' +
    "読み取れない項目はnull。年が不明な場合は今年（" + new Date().getFullYear() + "）とみなす。";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("api");
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const parsed = JSON.parse(clean);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/* ---------- 代表的な乗換経路を見積もる（Claude API） ----------
   注意：一般的な知識ベースの“目安”。当日の発車時刻・遅延は反映しない。 */
async function suggestRoute(from, to) {
  const prompt =
    `日本の公共交通機関で「${from}」から「${to}」への現在の経路を1つ、Web検索で確認して答えてください。` +
    "電車・バス・徒歩を含めてよい。実在する路線名・駅名・バス系統を使うこと。" +
    "最後に、経路をJSONだけで（前置き・Markdownなしで）出力してください。" +
    '形式: {"legs":[{"mode":"train"|"bus"|"walk","line":"路線名/系統 or 徒歩","from":"地点","to":"地点","minutes":整数}],' +
    '"transfers":乗換回数(整数),"totalMinutes":合計所要分(整数),"note":"補足(任意/短く)"}';
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error("api");
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const m = text.match(/\{[\s\S]*\}/); // 本文中からJSON部分を抽出
  const clean = (m ? m[0] : text).replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

/* ---------- 天気（Open-Meteo：APIキー不要・CORS対応） ---------- */
async function fetchWeather(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("wx");
  const d = await r.json();
  return {
    temp: Math.round(d.current.temperature_2m),
    code: d.current.weather_code,
    wind: Math.round(d.current.wind_speed_10m),
    humidity: d.current.relative_humidity_2m,
    max: Math.round(d.daily.temperature_2m_max[0]),
    min: Math.round(d.daily.temperature_2m_min[0]),
  };
}
async function geocodePlace(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ja`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("geo");
  const d = await r.json();
  const hit = d.results && d.results[0];
  return hit ? { name: hit.name, lat: hit.latitude, lng: hit.longitude, admin: hit.admin1 || "" } : null;
}
function weatherInfo(code) {
  const map = [
    { codes: [0], Icon: Sun, label: "快晴", color: "#C98A2B" },
    { codes: [1, 2], Icon: Cloud, label: "晴れ時々曇り", color: "#C98A2B" },
    { codes: [3], Icon: Cloud, label: "曇り", color: "#75726A" },
    { codes: [45, 48], Icon: CloudFog, label: "霧", color: "#75726A" },
    { codes: [51, 53, 55, 56, 57], Icon: CloudDrizzle, label: "霧雨", color: "#3D6CA6" },
    { codes: [61, 63, 65, 66, 67, 80, 81, 82], Icon: CloudRain, label: "雨", color: "#3D6CA6" },
    { codes: [71, 73, 75, 77, 85, 86], Icon: CloudSnow, label: "雪", color: "#3D6CA6" },
    { codes: [95, 96, 99], Icon: CloudLightning, label: "雷雨", color: "#C24B3C" },
  ];
  for (const m of map) if (m.codes.includes(code)) return m;
  return { Icon: Cloud, label: "—", color: "#75726A" };
}

/* ---------- 初期データ ---------- */
const today = new Date();
const t0 = ymd(today);
/* カレンダーの種類（カテゴリ） */
const seedCategories = [
  { id: "personal", name: "個人", color: "#3D6CA6" },
  { id: "work", name: "仕事", color: "#C24B3C" },
  { id: "family", name: "家族", color: "#2F7D5B" },
  { id: "hobby", name: "趣味", color: "#C98A2B" },
];
const DEFAULT_CAT = "personal";
const CAT_PALETTE = ["#3D6CA6", "#C24B3C", "#2F7D5B", "#C98A2B", "#7A4DA0", "#0E7C86", "#B4508A", "#5B6B7A"];
const seedEvents = [];
const seedShortcuts = [
  { id: "s1", name: "Gmail", url: "https://mail.google.com", color: "#C24B3C" },
  { id: "s2", name: "Google マップ", url: "https://maps.google.com", color: "#2F7D5B" },
  { id: "s3", name: "LINE", url: "https://line.me", color: "#3f9d3f" },
  { id: "s4", name: "天気", url: "https://weather.yahoo.co.jp", color: "#3D6CA6" },
  { id: "s5", name: "カレンダー", url: "https://calendar.google.com", color: "#C98A2B" },
  { id: "s6", name: "Amazon", url: "https://www.amazon.co.jp", color: "#232F42" },
];
/* よく使う予定（テンプレート）：日付を持たず、任意の日に再追加できる */
const seedTemplates = [];
/* 登録地点（天気表示用）：緯度経度を保持 */
const seedPlaces = [];

const uid = () => Math.random().toString(36).slice(2, 9);
const catOf = (cats, id) => cats.find((c) => c.id === id) || cats[0] || { name: "", color: "#75726A" };

const REMIND_OPTIONS = [0, 5, 10, 15, 30, 60]; // 開始の何分前
const remindLabel = (m) => (m === 0 ? "オフ" : m >= 60 ? `${m / 60}時間前` : `${m}分前`);

/* ---------- リマインドの発火時刻を算出 ----------
   各予定について、通知すべき瞬間の配列を返す。繰り返しは「次の発生分」を対象。
   ・開始 remind分前  … 「まもなく予定」
   ・出発時刻（場所と移動時間があるとき） … 「そろそろ出発」  */
function reminderMoments(ev, now) {
  const start = nextOccurrence(ev, now || new Date());
  if (!start) return [];
  const dk = ymd(start); // 発生日ごとに一意キー（毎日でも各日発火）
  const out = [];
  const lead = ev.remind == null ? 30 : Number(ev.remind);
  if (lead > 0) {
    out.push({
      key: `${ev.id}:${dk}:start`, at: new Date(start.getTime() - lead * 60000),
      title: ev.title, body: `${remindLabel(lead)}：${pad(start.getHours())}:${pad(start.getMinutes())} 開始`,
      level: "soon",
    });
  }
  if (ev.location && Number(ev.travelMin)) {
    const leave = new Date(start.getTime() - (Number(ev.travelMin) + BUFFER_MIN) * 60000);
    out.push({
      key: `${ev.id}:${dk}:leave`, at: leave,
      title: ev.title, body: `そろそろ出発：${ev.location} へ（移動約${ev.travelMin}分）`,
      level: "rush",
    });
  }
  return out;
}

/* ---------- 通知音（Web Audio、素材不要の二音チャイム） ---------- */
let _actx = null;
function playChime() {
  try {
    _actx = _actx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _actx;
    if (ctx.state === "suspended") ctx.resume();
    const now = ctx.currentTime;
    [[880, 0], [1174, 0.18]].forEach(([f, t]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.22, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.32);
      o.start(now + t); o.stop(now + t + 0.34);
    });
  } catch (e) { /* 音を鳴らせない環境は黙ってスキップ */ }
}

/* ---------- 端末カレンダー用 .ics（本体が閉じていても鳴るリマインド） ---------- */
function pad2(n) { return String(n).padStart(2, "0"); }
function icsStamp(d) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
}
function icsEsc(s) {
  return String(s || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}
/* 1件分の VEVENT 行を返す（日付があれば書き出す。時刻なしは終日予定） */
function veventLines(ev) {
  if (!ev.date) return null;
  const [y, mo, d] = ev.date.split("-").map(Number);
  const allDay = !ev.start;
  const lead = ev.remind == null ? 30 : Number(ev.remind);
  const lines = [
    "BEGIN:VEVENT",
    `UID:${ev.id}@sonar`, `DTSTAMP:${icsStamp(new Date())}`,
  ];
  if (allDay) {
    const next = new Date(y, mo - 1, d + 1);
    lines.push(`DTSTART;VALUE=DATE:${y}${pad2(mo)}${pad2(d)}`);
    lines.push(`DTEND;VALUE=DATE:${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`);
  } else {
    const [sh, sm] = ev.start.split(":").map(Number);
    const start = new Date(y, mo - 1, d, sh, sm);
    let end;
    if (ev.end) { const [eh, em] = ev.end.split(":").map(Number); end = new Date(y, mo - 1, d, eh, em); }
    else end = new Date(start.getTime() + 60 * 60000);
    lines.push(`DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`);
  }
  lines.push(`SUMMARY:${icsEsc(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsEsc(ev.location)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${icsEsc(ev.notes)}`);
  if (ev.repeat && RRULE_FREQ[ev.repeat]) {
    lines.push(`RRULE:FREQ=${RRULE_FREQ[ev.repeat]}`);
    if (Array.isArray(ev.exdates) && ev.exdates.length) {
      ev.exdates.forEach((ds) => {
        const [ey, emo, ed] = ds.split("-").map(Number);
        if (allDay) lines.push(`EXDATE;VALUE=DATE:${ey}${pad2(emo)}${pad2(ed)}`);
        else { const [eh, em] = ev.start.split(":").map(Number); lines.push(`EXDATE:${icsStamp(new Date(ey, emo - 1, ed, eh, em))}`); }
      });
    }
  }
  if (!allDay && lead > 0) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEsc(ev.title)}`,
      `TRIGGER:-PT${lead}M`, "END:VALARM");
  }
  lines.push("END:VEVENT");
  return lines;
}
function wrapCalendar(bodyLines) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SONAR//JP//", "CALSCALE:GREGORIAN",
    ...bodyLines, "END:VCALENDAR"].join("\r\n");
}
function buildICS(ev) {
  const body = veventLines(ev);
  return body ? wrapCalendar(body) : null;
}
/* 複数予定を1つの .ics にまとめる。追加できた件数も返す */
function buildICSAll(events) {
  const bodies = events.map(veventLines).filter(Boolean);
  if (bodies.length === 0) return { ics: null, count: 0 };
  return { ics: wrapCalendar(bodies.flat()), count: bodies.length };
}
function saveBlob(text, filename) {
  const blob = new Blob([text], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadICS(ev) {
  const ics = buildICS(ev);
  if (!ics) return;
  saveBlob(ics, `${(ev.title || "event").replace(/[\\/:*?"<>|]/g, "_")}.ics`);
}
function downloadAllICS(events) {
  const { ics, count } = buildICSAll(events);
  if (!ics) return 0;
  const d = new Date();
  saveBlob(ics, `SONAR_予定_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.ics`);
  return count;
}
/* 指定した年月に発生がある予定（繰り返し考慮） */
function eventsInMonth(events, y, m) {
  return events.filter((e) => hasOccurrenceInMonth(e, y, m));
}
/* 指定した年月の「発生」を1回ずつ個別の予定に展開（繰り返しを実体化） */
function expandMonthOccurrences(events, y, m) {
  const end = new Date(y, m + 1, 0).getDate();
  const out = [];
  for (const ev of events) {
    if (!ev.date) continue;
    for (let d = 1; d <= end; d++) {
      if (matchesRepeat(ev, new Date(y, m, d))) {
        out.push({ ...ev, date: `${y}-${pad(m + 1)}-${pad(d)}`, repeat: "none", exdates: undefined });
      }
    }
  }
  out.sort((a, b) => (a.date + (a.start || "")).localeCompare(b.date + (b.start || "")));
  return out;
}
/* その月の発生回数（繰り返しは回数で数える） */
function monthOccurrenceCount(events, y, m) {
  return expandMonthOccurrences(events, y, m).length;
}
function downloadMonthICS(events, y, m) {
  // 繰り返しはその月の各発生を個別の予定として書き出す
  const { ics, count } = buildICSAll(expandMonthOccurrences(events, y, m));
  if (!ics) return 0;
  saveBlob(ics, `SONAR_予定_${y}${pad2(m + 1)}.ics`);
  return count;
}

/* ============================================================
   メイン
   ============================================================ */
export default function App() {
  const [mode, setMode] = useState("auto"); // 'auto' | 'mobile' | 'desktop'
  const [theme, setTheme] = useState("light"); // 'light' | 'dark'
  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  const [tab, setTab] = useState("today"); // mobile tabs
  const [now, setNow] = useState(new Date());
  const [events, setEvents] = useState(seedEvents);
  const [shortcuts, setShortcuts] = useState(seedShortcuts);
  const [templates, setTemplates] = useState(seedTemplates);
  const [places, setPlaces] = useState(seedPlaces);
  const [categories, setCategories] = useState(seedCategories);
  const [activeCats, setActiveCats] = useState(seedCategories.map((c) => c.id));
  const toggleCat = (id) =>
    setActiveCats((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const catActive = (ev) => activeCats.includes(ev.cat || DEFAULT_CAT);
  const addCategory = (name, color) => {
    const nm = (name || "").trim();
    if (!nm) return;
    const id = "c" + uid();
    setCategories((prev) => [...prev, { id, name: nm, color }]);
    setActiveCats((prev) => [...prev, id]);
  };
  const removeCategory = (id) => {
    if (categories.length <= 1) return; // 最低1つは残す
    const remaining = categories.filter((c) => c.id !== id);
    const fallback = remaining[0].id;
    setCategories(remaining);
    setEvents((evs) => evs.map((e) => ((e.cat || DEFAULT_CAT) === id ? { ...e, cat: fallback } : e)));
    setTemplates((tps) => tps.map((t) => ((t.cat || DEFAULT_CAT) === id ? { ...t, cat: fallback } : t)));
    setActiveCats((prev) => {
      const next = prev.filter((x) => x !== id);
      return next.length ? next : remaining.map((c) => c.id);
    });
  };
  const [home, setHome] = useState(""); // 出発地（未設定なら登録を促す）
  const [selectedDate, setSelectedDate] = useState(t0);
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });

  /* ---- リマインド関連の状態 ---- */
  const [toasts, setToasts] = useState([]);
  const [soundOn, setSoundOn] = useState(true);
  const [notifyPerm, setNotifyPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const firedRef = useRef(null);
  const [routeEvent, setRouteEvent] = useState(null); // ポータル内乗換案内の対象

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ---- Supabase 同期（ログインしたユーザーごとに保存） ---- */
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(false); // 起動時のセッション復元完了
  const [synced, setSynced] = useState(null); // null=読込中, true=同期中, false=オフ/エラー
  const sessionRef = useRef(null);
  const loadedRef = useRef(false);
  const saveTimer = useRef(null);

  const applySession = (s) => {
    sessionRef.current = s;
    setSession(s);
    if (s) safeLS.set("sonar:session", JSON.stringify(s));
    else safeLS.del("sonar:session");
  };

  const hydrate = (d) => {
    if (!d) return;
    if (Array.isArray(d.events)) setEvents(d.events);
    if (Array.isArray(d.templates)) setTemplates(d.templates);
    if (Array.isArray(d.places)) setPlaces(d.places);
    if (Array.isArray(d.shortcuts)) setShortcuts(d.shortcuts);
    if (Array.isArray(d.categories) && d.categories.length) setCategories(d.categories);
    if (Array.isArray(d.activeCats)) setActiveCats(d.activeCats);
    if (typeof d.home === "string") setHome(d.home);
    if (d.theme === "dark" || d.theme === "light") setTheme(d.theme);
  };

  // 起動時：保存済みセッションを復元＆トークン更新
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!SB_CONFIGURED) { setAuthReady(true); return; }
      const raw = safeLS.get("sonar:session");
      if (raw) {
        try {
          const stored = JSON.parse(raw);
          const fresh = await sbRefresh(stored.refresh_token);
          if (!cancelled) applySession(fresh);
        } catch (e) {
          if (!cancelled) applySession(null);
        }
      }
      if (!cancelled) setAuthReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // サインイン後：そのユーザーのデータを読み込む
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    if (!session) { setSynced(null); return; }
    setSynced(null);
    (async () => {
      try {
        let d;
        try { d = await sbLoad(session); }
        catch (e) {
          if (String(e.message) === "401") { const ns = await sbRefresh(session.refresh_token); applySession(ns); d = await sbLoad(ns); }
          else throw e;
        }
        if (!cancelled) { hydrate(d); loadedRef.current = true; setSynced(true); }
      } catch (e) {
        if (!cancelled) { loadedRef.current = true; setSynced(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [session && session.user && session.user.id]);

  // 変更を自動保存（デバウンス）
  useEffect(() => {
    if (!session || !loadedRef.current || synced === false) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const payload = { events, templates, places, shortcuts, categories, activeCats, home, theme };
      try {
        try { await sbSave(sessionRef.current, payload); }
        catch (e) {
          if (String(e.message) === "401") { const ns = await sbRefresh(sessionRef.current.refresh_token); applySession(ns); await sbSave(ns, payload); }
          else throw e;
        }
        setSynced(true);
      } catch (e) { setSynced(false); }
    }, 700);
  }, [events, templates, places, shortcuts, categories, activeCats, home, theme, session]);

  const signOut = () => {
    applySession(null);
    loadedRef.current = false;
    // 表示は初期化（クラウド側は消さない）
    setEvents([]); setTemplates([]); setPlaces([]);
    setShortcuts(seedShortcuts); setCategories(seedCategories); setActiveCats(seedCategories.map((c) => c.id));
  };

  /* リマインド発火：毎秒スキャンし、到来した通知を鳴らす（重複は firedRef で防止） */
  useEffect(() => {
    if (!firedRef.current) firedRef.current = new Set();
    const n = now.getTime();
    const due = [];
    events.forEach((ev) =>
      reminderMoments(ev, now).forEach((m) => {
        const diff = n - m.at.getTime();
        if (diff >= 0 && diff < 90000 && !firedRef.current.has(m.key)) {
          firedRef.current.add(m.key);
          due.push(m);
        }
      })
    );
    if (due.length) {
      setToasts((prev) => [...prev, ...due.map((m) => ({ id: uid(), ...m }))]);
      if (soundOn) playChime();
      if (notifyPerm === "granted") {
        due.forEach((m) => { try { new Notification(m.title, { body: m.body }); } catch (e) {} });
      }
    }
  }, [now, events, soundOn, notifyPerm]);

  const dismissToast = (id) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const toggleNotify = async () => {
    if (typeof Notification === "undefined") { setNotifyPerm("unsupported"); return; }
    if (Notification.permission === "granted") { setNotifyPerm("granted"); return; }
    try { setNotifyPerm(await Notification.requestPermission()); }
    catch (e) { setNotifyPerm("denied"); }
  };

  /* 出発ゲート対象：これから開始する最も近い発生分（繰り返し考慮の発生コピー） */
  const gateEvent = useMemo(() => {
    return events
      .filter((e) => activeCats.includes(e.cat || DEFAULT_CAT))
      .map((e) => {
        const s = nextOccurrence(e, now);
        return s ? { ev: { ...e, date: ymd(s) }, s } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.ev)[0];
  }, [events, now, activeCats]);

  const addEvents = (list) => setEvents((prev) => [...prev, ...list]);
  const removeEvent = (id) => setEvents((prev) => prev.filter((e) => e.id !== id));
  const updateEvent = (id, patch) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  /* テンプレート（よく使う予定）：日付・end・id を落として登録。重複は無視 */
  const addTemplate = (src) => {
    const tpl = {
      id: uid(), title: (src.title || "").trim() || "（無題の予定）",
      start: src.start || "", location: src.location || "",
      travelMin: Number(src.travelMin) || 0, remind: src.remind == null ? 30 : Number(src.remind),
      repeat: src.repeat || "none", cat: src.cat || DEFAULT_CAT, notes: src.notes || "",
    };
    if (!tpl.title) return;
    setTemplates((prev) =>
      prev.some((t) => t.title === tpl.title && t.start === tpl.start && t.location === tpl.location)
        ? prev
        : [...prev, tpl]
    );
  };
  const removeTemplate = (id) => setTemplates((prev) => prev.filter((t) => t.id !== id));

  const addPlace = (p) =>
    setPlaces((prev) => (prev.some((x) => x.name === p.name) ? prev : [...prev, { id: uid(), ...p }]));
  const removePlace = (id) => setPlaces((prev) => prev.filter((p) => p.id !== id));

  const isMobile = mode === "mobile" || (mode === "auto" && vw < 640);
  const framedPhone = isMobile && vw >= 640; // 広い画面ではスマホ枠プレビュー、実機では全画面

  const darkCls = theme === "dark" ? " dark" : "";
  if (!SB_CONFIGURED) return <SetupScreen darkCls={darkCls} />;
  if (!authReady) return (
    <div className={"hub-root" + darkCls}><style>{CSS}</style>
      <div className="hub-auth-wrap"><Loader2 size={24} className="spin" /></div>
    </div>
  );
  if (!session) return <AuthScreen darkCls={darkCls} onSession={applySession} />;

  return (
    <div className={"hub-root" + darkCls}>
      <style>{CSS}</style>

      {/* ===== ツールバー（パソコン表示の上部バー） ===== */}
      {!isMobile && (
      <header className="hub-bar">
        <div className="hub-brand">
          <span className="hub-logo">SONAR</span>
          <span className="hub-tag">一日を、間に合わせる。</span>
        </div>
        <div className="hub-clock" aria-label="現在時刻">{fmtClock(now)}</div>
        <div className="hub-sync" title={synced === true ? "クラウド同期：オン" : synced === false ? "同期オフ（この環境では保存されません）" : "同期中…"}>
          {synced === null ? <Loader2 size={14} className="spin" /> : synced ? <Cloud size={14} /> : <CloudOff size={14} />}
        </div>
        <div className="hub-remindctl" role="group" aria-label="リマインド設定">
          <button
            className={"hub-rbtn" + (notifyPerm === "granted" ? " on" : "")}
            onClick={toggleNotify}
            title={
              notifyPerm === "granted" ? "ブラウザ通知：オン"
              : notifyPerm === "denied" ? "ブラウザ通知：ブロック中（ブラウザ設定で許可）"
              : notifyPerm === "unsupported" ? "この環境ではブラウザ通知を使えません"
              : "ブラウザ通知を許可する"
            }
          >
            {notifyPerm === "granted" ? <BellRing size={15} /> : notifyPerm === "denied" || notifyPerm === "unsupported" ? <BellOff size={15} /> : <Bell size={15} />}
          </button>
          <button
            className={"hub-rbtn" + (soundOn ? " on" : "")}
            onClick={() => setSoundOn((v) => !v)}
            title={soundOn ? "通知音：オン" : "通知音：オフ"}
          >
            {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
          <button
            className="hub-rbtn"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "ライトモードに切り替え" : "ダークモードに切り替え"}
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="hub-rbtn" onClick={signOut}
            title={(session && session.user && session.user.email ? session.user.email + " / " : "") + "ログアウト"}>
            <LogOut size={15} />
          </button>
        </div>
        <div className="hub-modeswitch" role="group" aria-label="表示モード">
          <button
            className={"hub-modebtn" + (mode === "auto" ? " on" : "")}
            onClick={() => setMode("auto")}
            title="画面サイズに合わせて自動で切り替え"
          >
            自動
          </button>
          <button
            className={"hub-modebtn" + (mode === "mobile" ? " on" : "")}
            onClick={() => setMode("mobile")}
          >
            <Smartphone size={15} /> スマホ
          </button>
          <button
            className={"hub-modebtn" + (mode === "desktop" ? " on" : "")}
            onClick={() => setMode("desktop")}
          >
            <Monitor size={15} /> パソコン
          </button>
        </div>
      </header>
      )}

      {/* ===== 本体 ===== */}
      {isMobile ? (
        <MobileShell
          tab={tab} setTab={setTab} now={now}
          gateEvent={gateEvent} home={home}
          events={events} selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          view={view} setView={setView} addEvents={addEvents} removeEvent={removeEvent}
          updateEvent={updateEvent} onRoute={setRouteEvent}
          templates={templates} addTemplate={addTemplate} removeTemplate={removeTemplate}
          places={places} addPlace={addPlace} removePlace={removePlace}
          categories={categories} activeCats={activeCats} toggleCat={toggleCat} addCategory={addCategory} removeCategory={removeCategory}
          shortcuts={shortcuts} setShortcuts={setShortcuts} setHome={setHome}
          setMode={setMode} notifyPerm={notifyPerm} toggleNotify={toggleNotify}
          soundOn={soundOn} setSoundOn={setSoundOn} framed={framedPhone}
          theme={theme} setTheme={setTheme} synced={synced} signOut={signOut}
        />
      ) : (
        <DesktopShell
          now={now} gateEvent={gateEvent} home={home} setHome={setHome}
          events={events} selectedDate={selectedDate} setSelectedDate={setSelectedDate}
          view={view} setView={setView} addEvents={addEvents} removeEvent={removeEvent}
          updateEvent={updateEvent} onRoute={setRouteEvent}
          templates={templates} addTemplate={addTemplate} removeTemplate={removeTemplate}
          places={places} addPlace={addPlace} removePlace={removePlace}
          categories={categories} activeCats={activeCats} toggleCat={toggleCat} addCategory={addCategory} removeCategory={removeCategory}
          shortcuts={shortcuts} setShortcuts={setShortcuts}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {routeEvent && (
        <RouteModal
          ev={routeEvent} home={home} updateEvent={updateEvent}
          onClose={() => setRouteEvent(null)}
        />
      )}
    </div>
  );
}

/* ============================================================
   リマインドのトースト
   ============================================================ */
function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="hub-toasts" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} t={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
function Toast({ t, onDismiss }) {
  useEffect(() => {
    const id = setTimeout(() => onDismiss(t.id), 12000);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className={"hub-toast lv-" + t.level} role="alert">
      <span className="hub-signal" data-lv={t.level} />
      <div className="hub-toast-body">
        <div className="hub-toast-title">{t.title}</div>
        <div className="hub-toast-msg">{t.body}</div>
      </div>
      <button className="hub-toast-x" onClick={() => onDismiss(t.id)} aria-label="閉じる"><X size={15} /></button>
    </div>
  );
}

/* ============================================================
   ポータル内・乗換案内モーダル
   ============================================================ */
function RouteModal({ ev, home, updateEvent, onClose }) {
  const [travelMin, setTravelMin] = useState(Number(ev.travelMin) || 30);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = eventStart(ev);
  let arrive = null, depart = null;
  if (start) {
    arrive = new Date(start.getTime() - BUFFER_MIN * 60000);
    depart = new Date(arrive.getTime() - travelMin * 60000);
  }

  const runAI = async () => {
    if (!home) { setError("先に出発ゲートで出発地を登録してください。"); return; }
    setError(""); setLoading(true); setRoute(null);
    try {
      const r = await suggestRoute(home, ev.location);
      setRoute(r);
    } catch (e) {
      setError("経路の見積もりに失敗しました。もう一度お試しください。");
    } finally { setLoading(false); }
  };

  const applyTravel = () => updateEvent(ev.id, { travelMin: Number(travelMin) || 0 });

  return (
    <div className="hub-modal-backdrop" onClick={onClose}>
      <div className="hub-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="乗換案内">
        <div className="hub-modal-head">
          <div className="hub-eyebrow">乗換案内</div>
          <button className="hub-modal-close" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        </div>

        <div className="hub-route-od">
          <span className="hub-od-chip"><Home size={13} /> {home}</span>
          <ArrowRight size={15} className="hub-arrow" />
          <span className="hub-od-chip dest"><MapPin size={13} /> {ev.location}</span>
        </div>
        <div className="hub-route-for">{ev.title}</div>

        {/* 到着から逆算したタイムライン（アプリ内・実データの時刻計算） */}
        {start ? (
          <div className="hub-timeline">
            <TLRow time={hhmm(depart)} label="出発" sub={home} node="start" />
            <TLRow time="" label={`乗車 約${travelMin}分`} sub={route ? `${route.transfers ?? 0}回乗換` : "所要時間は下で調整"} node="mid" mid />
            <TLRow time={hhmm(arrive)} label="到着" sub={ev.location} node="mid" />
            <TLRow time="" label={`支度・徒歩 ${BUFFER_MIN}分`} sub="" node="mid" mid />
            <TLRow time={hhmm(start)} label="予定開始" sub={ev.title} node="end" />
          </div>
        ) : (
          <div className="hub-note err" style={{ marginTop: 12 }}>
            この予定は開始時刻が未設定のため、出発時刻を計算できません。
          </div>
        )}

        {/* 所要時間の調整 */}
        <div className="hub-travel-edit">
          <span className="hub-te-label">移動時間の目安</span>
          <div className="hub-te-ctl">
            <button className="hub-iconbtn" onClick={() => setTravelMin((v) => Math.max(0, Number(v) - 5))} aria-label="5分減らす">−</button>
            <span className="hub-te-val">{travelMin}<small>分</small></span>
            <button className="hub-iconbtn" onClick={() => setTravelMin((v) => Number(v) + 5)} aria-label="5分増やす">＋</button>
            <button className="hub-ghostbtn" onClick={applyTravel}><Check size={14} /> 予定に反映</button>
          </div>
        </div>

        {/* Web検索による経路の目安 */}
        <button className="hub-primary full" onClick={runAI} disabled={loading}>
          {loading ? <><Loader2 size={15} className="spin" /> 経路を調べています…</> : <><Train size={15} /> 経路を調べる（Web検索）</>}
        </button>
        {error && <div className="hub-note err" style={{ marginTop: 10 }}>{error}</div>}

        {route && (
          <div className="hub-ai-route">
            <div className="hub-ai-summary">
              <span>所要 約{route.totalMinutes}分</span>
              <span>乗換 {route.transfers ?? 0}回</span>
              {Number(route.totalMinutes) ? (
                <button className="hub-apply-mini" onClick={() => setTravelMin(Number(route.totalMinutes))}>
                  この所要を反映
                </button>
              ) : null}
            </div>
            <ul className="hub-legs">
              {(route.legs || []).map((lg, i) => (
                <li key={i} className={"hub-leg" + (lg.mode === "walk" ? " walk" : lg.mode === "bus" ? " bus" : "")}>
                  <span className="hub-leg-ic">
                    {lg.mode === "walk" ? "徒歩" : lg.mode === "bus" ? <Bus size={13} /> : <Train size={13} />}
                  </span>
                  <span className="hub-leg-main">
                    <span className="hub-leg-line">{lg.line}</span>
                    <span className="hub-leg-od">{lg.from} → {lg.to}</span>
                  </span>
                  <span className="hub-leg-mins">{lg.minutes}分</span>
                </li>
              ))}
            </ul>
            {route.note && <div className="hub-ai-memo">{route.note}</div>}
            <div className="hub-ai-note">
              ※ Web検索に基づく経路の目安です。正確な発車時刻・遅延・運休・運賃は下のYahoo!乗換で確認してください。
            </div>
          </div>
        )}

        <div className="hub-modal-ext">
          正確な発車時刻を確認：
          <a href={gmapsUrl(home, ev.location)} target="_blank" rel="noreferrer">Google</a>
          <a href={yahooUrl(home, ev.location)} target="_blank" rel="noreferrer">Yahoo!乗換</a>
        </div>
      </div>
    </div>
  );
}
function TLRow({ time, label, sub, node, mid }) {
  return (
    <div className={"hub-tl-row" + (mid ? " mid" : "")}>
      <div className="hub-tl-time">{time}</div>
      <div className="hub-tl-rail">
        <span className={"hub-tl-node n-" + node} />
      </div>
      <div className="hub-tl-body">
        <div className="hub-tl-label">{label}</div>
        {sub && <div className="hub-tl-sub">{sub}</div>}
      </div>
    </div>
  );
}

/* ============================================================
   ログイン / 新規登録
   ============================================================ */
function AuthScreen({ darkCls, onSession }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async () => {
    setErr(""); setMsg("");
    if (!email.trim() || pw.length < 6) { setErr("メールと6文字以上のパスワードを入力してください。"); return; }
    setBusy(true);
    try {
      if (mode === "signin") {
        onSession(await sbSignIn(email.trim(), pw));
      } else {
        const s = await sbSignUp(email.trim(), pw);
        if (s.access_token) onSession(s);
        else { setMsg("登録しました。確認メールが必要な設定の場合は、メール確認後にログインしてください。"); setMode("signin"); }
      }
    } catch (e) { setErr(e.message || "失敗しました"); }
    finally { setBusy(false); }
  };
  return (
    <div className={"hub-root" + darkCls}><style>{CSS}</style>
      <div className="hub-auth-wrap">
        <div className="hub-auth">
          <div className="hub-auth-logo">SONAR</div>
          <div className="hub-auth-sub">{mode === "signin" ? "ログインしてポータルを開く" : "アカウントを作成"}</div>
          <input className="hub-di" type="email" placeholder="メールアドレス" value={email}
            onChange={(e) => setEmail(e.target.value)} autoFocus />
          <input className="hub-di" type="password" placeholder="パスワード（6文字以上）" value={pw}
            onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          {err && <div className="hub-note err">{err}</div>}
          {msg && <div className="hub-note loading">{msg}</div>}
          <button className="hub-primary full" onClick={submit} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : mode === "signin" ? <LogIn size={15} /> : <UserPlus size={15} />}
            {mode === "signin" ? "ログイン" : "登録する"}
          </button>
          <button className="hub-auth-switch"
            onClick={() => { setMode((m) => (m === "signin" ? "signup" : "signin")); setErr(""); setMsg(""); }}>
            {mode === "signin" ? "アカウントを新規作成" : "既にアカウントをお持ちの方はログイン"}
          </button>
        </div>
      </div>
    </div>
  );
}

const SETUP_SQL = `create table if not exists public.portals (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.portals enable row level security;
create policy "own select" on public.portals for select using (auth.uid() = user_id);
create policy "own insert" on public.portals for insert with check (auth.uid() = user_id);
create policy "own update" on public.portals for update using (auth.uid() = user_id);`;

function SetupScreen({ darkCls }) {
  return (
    <div className={"hub-root" + darkCls}><style>{CSS}</style>
      <div className="hub-auth-wrap">
        <div className="hub-auth wide">
          <div className="hub-auth-logo">SONAR</div>
          <div className="hub-auth-sub">Supabase の設定が必要です</div>
          <p className="hub-setup-p">コード上部の <b>SUPABASE_URL</b> と <b>SUPABASE_ANON_KEY</b> に、ご自身のSupabaseプロジェクトの値（Project Settings → API）を設定してください。次に、SupabaseのSQLエディタで下記を1回だけ実行し、保存用テーブルと権限（RLS）を作成します。</p>
          <pre className="hub-setup-sql">{SETUP_SQL}</pre>
          <p className="hub-setup-p">設定後に開くと、ログイン画面が表示されます。ユーザーごとに自分の予定だけが保存・表示されます。</p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   デスクトップ
   ============================================================ */
function DesktopShell(props) {
  const {
    now, gateEvent, home, setHome, events, selectedDate, setSelectedDate,
    view, setView, addEvents, removeEvent, updateEvent, onRoute,
    templates, addTemplate, removeTemplate, places, addPlace, removePlace,
    categories, activeCats, toggleCat, addCategory, removeCategory, shortcuts, setShortcuts,
  } = props;
  return (
    <main className="hub-desk">
      <DepartureGate ev={gateEvent} now={now} home={home} setHome={setHome} onRoute={onRoute} categories={categories} big />
      <div className="hub-grid">
        <section className="hub-col">
          <CalendarPanel
            events={events} view={view} setView={setView}
            selectedDate={selectedDate} setSelectedDate={setSelectedDate}
            categories={categories} activeCats={activeCats} toggleCat={toggleCat} addCategory={addCategory} removeCategory={removeCategory}
          />
        </section>
        <section className="hub-col">
          <DayPanel
            now={now} selectedDate={selectedDate} events={events}
            addEvents={addEvents} removeEvent={removeEvent} updateEvent={updateEvent} home={home} onRoute={onRoute}
            templates={templates} addTemplate={addTemplate} removeTemplate={removeTemplate}
            categories={categories} activeCats={activeCats}
          />
        </section>
      </div>
      <section className="hub-desk-apps">
        <WeatherPanel places={places} addPlace={addPlace} removePlace={removePlace} />
      </section>
      {/* ショートカットはウィンドウ幅に関わらず常に最下部・全幅 */}
      <section className="hub-desk-apps">
        <ShortcutPanel shortcuts={shortcuts} setShortcuts={setShortcuts} />
      </section>
    </main>
  );
}

/* ============================================================
   モバイル（端末フレーム＋下タブ）
   ============================================================ */
function MobileShell(props) {
  const {
    tab, setTab, now, gateEvent, home, setHome, events, selectedDate,
    setSelectedDate, view, setView, addEvents, removeEvent, updateEvent, onRoute,
    templates, addTemplate, removeTemplate, places, addPlace, removePlace,
    categories, activeCats, toggleCat, addCategory, removeCategory, shortcuts, setShortcuts,
    setMode, notifyPerm, toggleNotify, soundOn, setSoundOn, framed, theme, setTheme, synced, signOut,
  } = props;
  return (
    <div className={"hub-phonewrap" + (framed ? "" : " bare")}>
      <div className={"hub-phone" + (framed ? "" : " bare")}>
        <div className="hub-phonebar">
          <div className="hub-pb-brand">
            <span className="hub-logo">SONAR</span>
            <span className="hub-pb-clock">{fmtClock(now)}</span>
            <span className="hub-sync" title={synced === true ? "クラウド同期：オン" : synced === false ? "同期オフ" : "同期中…"}>
              {synced === null ? <Loader2 size={13} className="spin" /> : synced ? <Cloud size={13} /> : <CloudOff size={13} />}
            </span>
          </div>
          <div className="hub-pb-ctl">
            <button className={"hub-rbtn" + (notifyPerm === "granted" ? " on" : "")} onClick={toggleNotify}
              aria-label="通知">
              {notifyPerm === "granted" ? <BellRing size={15} /> : notifyPerm === "denied" || notifyPerm === "unsupported" ? <BellOff size={15} /> : <Bell size={15} />}
            </button>
            <button className={"hub-rbtn" + (soundOn ? " on" : "")} onClick={() => setSoundOn((v) => !v)} aria-label="通知音">
              {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
            </button>
            <button className="hub-rbtn" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              aria-label="テーマ切替">
              {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            <button className="hub-rbtn" onClick={signOut} aria-label="ログアウト">
              <LogOut size={15} />
            </button>
            <button className="hub-pb-pc" onClick={() => setMode("desktop")} title="パソコン表示に切り替え">
              <Monitor size={14} /> PC
            </button>
          </div>
        </div>
        <div className="hub-phonescroll">
          {tab === "today" && (
            <>
              <DepartureGate ev={gateEvent} now={now} home={home} setHome={setHome} onRoute={onRoute} categories={categories} />
              <DayPanel
                now={now} selectedDate={selectedDate} events={events}
                addEvents={addEvents} removeEvent={removeEvent} updateEvent={updateEvent} home={home} onRoute={onRoute}
                templates={templates} addTemplate={addTemplate} removeTemplate={removeTemplate}
                categories={categories} activeCats={activeCats} compact
              />
            </>
          )}
          {tab === "calendar" && (
            <CalendarPanel
              events={events} view={view} setView={setView}
              selectedDate={selectedDate} setSelectedDate={setSelectedDate}
              categories={categories} activeCats={activeCats} toggleCat={toggleCat} addCategory={addCategory} removeCategory={removeCategory}
              onPick={() => setTab("today")}
            />
          )}
          {tab === "weather" && (
            <WeatherPanel places={places} addPlace={addPlace} removePlace={removePlace} />
          )}
          {tab === "apps" && (
            <ShortcutPanel shortcuts={shortcuts} setShortcuts={setShortcuts} />
          )}
        </div>
        <nav className="hub-tabbar">
          <TabBtn on={tab === "today"} onClick={() => setTab("today")} icon={<Train size={18} />} label="きょう" />
          <TabBtn on={tab === "calendar"} onClick={() => setTab("calendar")} icon={<Calendar size={18} />} label="カレンダー" />
          <TabBtn on={tab === "weather"} onClick={() => setTab("weather")} icon={<Sun size={18} />} label="天気" />
          <TabBtn on={tab === "apps"} onClick={() => setTab("apps")} icon={<LayoutGrid size={18} />} label="アプリ" />
        </nav>
      </div>
    </div>
  );
}
function TabBtn({ on, onClick, icon, label }) {
  return (
    <button className={"hub-tab" + (on ? " on" : "")} onClick={onClick}>
      {icon}<span>{label}</span>
    </button>
  );
}

/* ============================================================
   出発ゲート（シグネチャー）
   ============================================================ */
function DepartureGate({ ev, now, home, setHome, onRoute, categories = [], big }) {
  const [editHome, setEditHome] = useState(false);
  const info = ev ? leaveInfo(ev, now) : null;

  const HomeField = () => (
    !editHome ? (
      <button className={"hub-origin" + (home ? "" : " unset")} onClick={() => setEditHome(true)}
        title="出発地を登録・変更">
        <Home size={13} /> {home || "出発地を登録"}
      </button>
    ) : (
      <input
        className="hub-origin-input" autoFocus defaultValue={home}
        placeholder="駅名・地名（例：田端駅）"
        onBlur={(e) => { setHome(e.target.value.trim() || home); setEditHome(false); }}
        onKeyDown={(e) => { if (e.key === "Enter") { setHome(e.target.value.trim() || home); setEditHome(false); } }}
      />
    )
  );

  if (!ev || !info) {
    return (
      <div className={"hub-gate empty" + (big ? " big" : "")}>
        <div className="hub-gate-eyebrow">出発ゲート</div>
        <div className="hub-gate-empty">次に出かける予定はありません。ゆっくりどうぞ。</div>
        <div className="hub-gate-route" style={{ marginTop: 10 }}>
          <HomeField />
          {!home && <span className="hub-gate-hint">← いつもの出発地を登録しておくと、出発時刻を計算できます</span>}
        </div>
      </div>
    );
  }

  const leaveStr = info.leave ? `${pad(info.leave.getHours())}:${pad(info.leave.getMinutes())}` : "--:--";
  const startStr = `${pad(info.start.getHours())}:${pad(info.start.getMinutes())}`;
  const cd = info.minToLeave;
  const cdLabel =
    cd == null ? "" : cd <= 0 ? "出発時刻を過ぎています" : cd >= 60
      ? `あと ${Math.floor(cd / 60)}時間${cd % 60}分`
      : `あと ${cd}分`;

  return (
    <div className={"hub-gate lv-" + info.level + (big ? " big" : "")}>
      <div className="hub-gate-eyebrow">
        出発ゲート <span className="hub-signal" data-lv={info.level} /> {info.label}
      </div>
      <div className="hub-gate-body">
        <div className="hub-gate-left">
          <div className="hub-gate-title">
            <span className="hub-gate-cat" style={{ background: catOf(categories, ev.cat || DEFAULT_CAT).color }} />
            {ev.title}
          </div>
          <div className="hub-gate-route">
            <HomeField />
            <ArrowRight size={14} className="hub-arrow" />
            <span className="hub-dest"><MapPin size={13} /> {ev.location || "行き先未設定"}</span>
          </div>
          {ev.location && (
            <div className="hub-gate-links">
              <button className="hub-link" onClick={() => onRoute(ev)}>
                <Train size={14} /> 乗換案内を見る
              </button>
              <button className="hub-link ghost" onClick={() => downloadICS(ev)}
                title="端末カレンダーに追加（.ics）">
                <CalendarPlus size={14} /> カレンダーに保存
              </button>
            </div>
          )}
        </div>
        <div className="hub-gate-right">
          <div className="hub-board">
            <div className="hub-board-row">
              <span className="hub-board-k">出発</span>
              <span className="hub-board-t">{leaveStr}</span>
            </div>
            <div className="hub-board-row muted">
              <span className="hub-board-k">開始</span>
              <span className="hub-board-t sm">{startStr}</span>
            </div>
          </div>
          <div className="hub-countdown">{cdLabel}</div>
          <div className="hub-traveltag">移動 約{ev.travelMin || "?"}分 ＋ 支度{BUFFER_MIN}分</div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   カレンダー
   ============================================================ */
function CalendarPanel({ events, view, setView, selectedDate, setSelectedDate, onPick,
  categories = [], activeCats = [], toggleCat, addCategory, removeCategory }) {
  const [manageCat, setManageCat] = useState(false);
  const [newCat, setNewCat] = useState({ name: "", color: CAT_PALETTE[0] });
  const first = new Date(view.y, view.m, 1);
  const startPad = first.getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const isShown = (e) => activeCats.includes(e.cat || DEFAULT_CAT);
  // その日に発生する（表示中の種類の）カテゴリ色の一覧（重複なし・最大4）
  const dayColors = (d) => {
    const s = `${view.y}-${pad(view.m + 1)}-${pad(d)}`;
    const cs = [];
    for (const e of events) {
      if (!isShown(e) || !occursOn(e, s)) continue;
      const c = catOf(categories, e.cat || DEFAULT_CAT).color;
      if (!cs.includes(c)) cs.push(c);
      if (cs.length >= 4) break;
    }
    return cs;
  };
  const selD = parseYmd(selectedDate);
  const selY = selD.getFullYear(), selM = selD.getMonth();
  const selMonthCount = monthOccurrenceCount(events.filter(isShown), selY, selM);
  const move = (delta) => {
    let m = view.m + delta, y = view.y;
    if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    setView({ y, m });
    setSelectedDate(`${y}-${pad(m + 1)}-01`);
  };

  return (
    <div className="hub-card">
      <div className="hub-eyebrow">カレンダー</div>
      {categories.length > 0 && toggleCat && (
        <div className="hub-catbox">
          <div className="hub-catfilter">
            {categories.map((c) => {
              const on = activeCats.includes(c.id);
              return (
                <span key={c.id} className="hub-catwrap">
                  <button className={"hub-catpill" + (on ? " on" : "")}
                    style={on ? { background: c.color, borderColor: c.color } : { borderColor: c.color, color: c.color }}
                    onClick={() => toggleCat(c.id)}>
                    <span className="hub-catdot" style={{ background: on ? "#fff" : c.color }} />{c.name}
                  </button>
                  {manageCat && categories.length > 1 && (
                    <button className="hub-catdel" onClick={() => removeCategory(c.id)} aria-label="種類を削除"><X size={11} /></button>
                  )}
                </span>
              );
            })}
            {addCategory && (
              <button className="hub-catedit" onClick={() => setManageCat((v) => !v)}>
                {manageCat ? "完了" : "編集"}
              </button>
            )}
          </div>
          {manageCat && addCategory && (
            <div className="hub-catadd">
              <input className="hub-di" placeholder="種類の名前（例：勉強）" value={newCat.name}
                onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { addCategory(newCat.name, newCat.color); setNewCat({ name: "", color: CAT_PALETTE[0] }); } }} />
              <div className="hub-swatches">
                {CAT_PALETTE.map((col) => (
                  <button key={col} className={"hub-swatch" + (newCat.color === col ? " on" : "")}
                    style={{ background: col }} onClick={() => setNewCat({ ...newCat, color: col })} aria-label="色" />
                ))}
              </div>
              <button className="hub-primary sm" onClick={() => { addCategory(newCat.name, newCat.color); setNewCat({ name: "", color: CAT_PALETTE[0] }); }}>
                <Plus size={14} /> 追加
              </button>
            </div>
          )}
        </div>
      )}
      <div className="hub-cal-head">
        <button className="hub-iconbtn" onClick={() => move(-1)} aria-label="前の月"><ChevronLeft size={18} /></button>
        <div className="hub-cal-month">{view.y}<span>年</span> {view.m + 1}<span>月</span></div>
        <button className="hub-iconbtn" onClick={() => move(1)} aria-label="次の月"><ChevronRight size={18} /></button>
      </div>
      <div className="hub-cal-grid hub-cal-wd">
        {WD.map((w, i) => (
          <div key={w} className={"hub-wd" + (i === 0 ? " sun" : i === 6 ? " sat" : "")}>{w}</div>
        ))}
      </div>
      <div className="hub-cal-grid">
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="hub-day empty" />;
          const s = `${view.y}-${pad(view.m + 1)}-${pad(d)}`;
          const isToday = s === t0;
          const isSel = s === selectedDate;
          const wd = new Date(view.y, view.m, d).getDay();
          const colors = dayColors(d);
          return (
            <button
              key={i}
              className={"hub-day" + (isSel ? " sel" : "") + (isToday ? " today" : "") +
                (wd === 0 ? " sun" : wd === 6 ? " sat" : "")}
              onClick={() => { setSelectedDate(s); onPick && onPick(); }}
            >
              <span className="hub-daynum">{d}</span>
              {colors.length > 0 && (
                <span className="hub-dots">
                  {colors.map((c, k) => <span key={k} className="hub-dot" style={{ background: c }} />)}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="hub-cal-foot">
        <button
          className="hub-primary full"
          onClick={() => downloadMonthICS(events.filter(isShown), selY, selM)}
          disabled={selMonthCount === 0}
          title="選択中の日の月の予定（表示中の種類）をまとめて .ics に書き出します"
        >
          <CalendarPlus size={15} /> {selY}年{selM + 1}月を保存（{selMonthCount}件）
        </button>
        <button
          className="hub-ghostbtn wide"
          onClick={() => downloadAllICS(events)}
          disabled={events.length === 0}
          title="登録中の全予定を1つの .ics にまとめて書き出します"
        >
          すべての予定を保存（{events.length}件）
        </button>
        <p className="hub-cal-note">「◯月」は選択中の日の月で、繰り返しはその月の発生回数で数えます。「すべて」は繰り返しを1本のルール（無期限）として書き出します。</p>
      </div>
    </div>
  );
}

/* ============================================================
   選択日の予定 ＋ 写真取り込み ＋ 手入力
   ============================================================ */
function DayPanel({ now, selectedDate, events, addEvents, removeEvent, updateEvent, home, onRoute,
  templates, addTemplate, removeTemplate, categories = [], activeCats = [], compact }) {
  const [drafts, setDrafts] = useState([]);     // 写真から抽出した下書き
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null); // 編集中のマスター予定
  const [manageTpl, setManageTpl] = useState(false); // テンプレ削除モード
  const [delId, setDelId] = useState(null);          // 繰り返し予定の削除確認
  const fileRef = useRef(null);

  /* テンプレートを選択日に追加 */
  const addFromTemplate = (tpl) => {
    addEvents([{
      id: uid(), title: tpl.title, date: selectedDate, start: tpl.start || "", end: "",
      location: tpl.location || "", travelMin: Number(tpl.travelMin) || 0,
      remind: tpl.remind == null ? 30 : Number(tpl.remind), repeat: tpl.repeat || "none",
      cat: tpl.cat || DEFAULT_CAT, notes: tpl.notes || "", source: "template",
    }]);
  };

  // 選択日に発生する予定（表示中の種類のみ・繰り返しは発生日を date に）を時系列順に
  const startMin = (e) => {
    if (!e.start) return -1; // 時刻なし（終日）は先頭
    const [h, m] = e.start.split(":").map(Number);
    return h * 60 + m;
  };
  const dayEvents = events
    .filter((e) => occursOn(e, selectedDate) && activeCats.includes(e.cat || DEFAULT_CAT))
    .map((e) => (e.date === selectedDate ? e : { ...e, date: selectedDate }))
    .sort((a, b) => startMin(a) - startMin(b));

  const d = parseYmd(selectedDate);
  const heading = `${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`;

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(""); setLoading(true); setDrafts([]);
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1]);
        r.onerror = () => rej(new Error("read"));
        r.readAsDataURL(file);
      });
      const list = await extractEventsFromImage(base64, file.type || "image/jpeg");
      const mapped = list.map((x) => ({
        id: uid(),
        title: x.title || "（無題の予定）",
        date: x.date || selectedDate,
        start: x.start || "",
        end: x.end || "",
        location: x.location || "",
        travelMin: 30,
        notes: x.notes || "",
        remind: 30,
        repeat: "none",
        cat: DEFAULT_CAT,
        source: "photo",
      }));
      if (mapped.length === 0) setError("予定を見つけられませんでした。手入力で追加できます。");
      setDrafts(mapped);
    } catch (err) {
      setError("読み取れませんでした。手入力で追加してください。");
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const confirmDraft = (id) => {
    const d2 = drafts.find((x) => x.id === id);
    if (d2) addEvents([d2]);
    setDrafts((prev) => prev.filter((x) => x.id !== id));
  };
  const editDraft = (id, patch) =>
    setDrafts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  return (
    <div className="hub-card">
      <div className="hub-eyebrow">予定</div>
      <div className="hub-day-head">
        <h2 className="hub-day-title">{heading}</h2>
        <div className="hub-day-actions">
          <button className="hub-primary" onClick={() => fileRef.current?.click()}>
            <Camera size={15} /> 写真から追加
          </button>
          <button className="hub-ghostbtn" onClick={() => setShowForm((v) => !v)}>
            <Plus size={15} /> 手入力
          </button>
        </div>
      </div>
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />

      {loading && (
        <div className="hub-note loading">
          <Loader2 size={16} className="spin" /> 写真を読み取っています…
        </div>
      )}
      {error && <div className="hub-note err">{error}</div>}

      {/* 取り込み時の一括操作 */}
      {drafts.length > 1 && (
        <div className="hub-bulkbar">
          <span>{drafts.length}件の予定が見つかりました</span>
          <div className="hub-bulk-actions">
            <button className="hub-primary sm" onClick={() => { addEvents(drafts); setDrafts([]); }}>
              <Check size={14} /> すべて追加
            </button>
            <button className="hub-ghostbtn" onClick={() => setDrafts([])}>すべて破棄</button>
          </div>
        </div>
      )}

      {/* 写真からの下書き */}
      {drafts.map((dr) => (
        <div key={dr.id} className="hub-draft">
          <div className="hub-draft-badge"><ImageIcon size={12} /> 写真から</div>
          <input className="hub-di title" value={dr.title}
            onChange={(e) => editDraft(dr.id, { title: e.target.value })} />
          <div className="hub-di-row">
            <input className="hub-di grow" type="date" value={dr.date}
              onChange={(e) => editDraft(dr.id, { date: e.target.value })} />
          </div>
          <label className="hub-time-row"><span>開始</span><TimeSelect value={dr.start} onChange={(v) => editDraft(dr.id, { start: v })} /></label>
          <input className="hub-di" placeholder="場所（駅名など）" value={dr.location}
            onChange={(e) => editDraft(dr.id, { location: e.target.value })} />
          <label className="hub-di-repeat">
            <Repeat size={13} /> 繰り返し
            <select className="hub-di" value={dr.repeat || "none"}
              onChange={(e) => editDraft(dr.id, { repeat: e.target.value })}>
              {REPEAT_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </label>
          <div className="hub-draft-foot">
            <button className="hub-primary sm" onClick={() => confirmDraft(dr.id)}>
              <Check size={14} /> カレンダーに追加
            </button>
            <button className="hub-iconbtn" onClick={() => setDrafts((p) => p.filter((x) => x.id !== dr.id))}>
              <X size={16} />
            </button>
          </div>
        </div>
      ))}

      {showForm && (
        <ManualForm
          defaultDate={selectedDate} home={home} categories={categories}
          onSubmit={(ev, asTpl) => {
            addEvents([{ ...ev, id: uid(), source: "manual" }]);
            if (asTpl) addTemplate(ev);
            setShowForm(false);
          }}
          onClose={() => setShowForm(false)}
        />
      )}
      {editing && (
        <ManualForm
          defaultDate={selectedDate} home={home} categories={categories}
          initial={editing}
          onSubmit={(ev, asTpl) => {
            updateEvent(editing.id, ev);
            if (asTpl) addTemplate(ev);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {/* 当日の予定リスト */}
      {dayEvents.length === 0 ? (
        <div className="hub-empty-day">
          この日の予定はまだありません。写真から取り込むか、手入力で追加できます。
        </div>
      ) : (
        <ul className="hub-evlist">
          {dayEvents.map((ev) => {
            const info = leaveInfo(ev, now);
            const ct = catOf(categories, ev.cat || DEFAULT_CAT);
            return (
              <li key={ev.id} className="hub-ev">
                <span className="hub-ev-cat" style={{ background: ct.color }} />
                <div className="hub-ev-time">
                  {ev.start ? (
                    <>
                      <span className="hub-ev-start">{ev.start}</span>
                      {ev.end && <span className="hub-ev-end">〜{ev.end}</span>}
                    </>
                  ) : (
                    <span className="hub-ev-allday">終日</span>
                  )}
                </div>
                <div className="hub-ev-main">
                  <div className="hub-ev-title">
                    {ev.title}
                    <span className="hub-ev-cattag" style={{ color: ct.color, borderColor: ct.color }}>{ct.name}</span>
                    {ev.repeat && ev.repeat !== "none" && (
                      <span className="hub-ev-repeat"><Repeat size={11} /> {REPEAT_LABEL[ev.repeat]}</span>
                    )}
                  </div>
                  {ev.location && (
                    <div className="hub-ev-loc"><MapPin size={12} /> {ev.location}
                      {ev.travelMin ? <span className="hub-ev-travel">・移動約{ev.travelMin}分</span> : null}
                    </div>
                  )}
                  {info && info.level !== "done" && (
                    <div className={"hub-ev-leave lv-" + info.level}>
                      <span className="hub-signal sm" data-lv={info.level} />
                      {info.leave
                        ? `${pad(info.leave.getHours())}:${pad(info.leave.getMinutes())} までに出発`
                        : info.label}
                    </div>
                  )}
                  <div className="hub-ev-tools">
                    {ev.location && (
                      <button className="hub-ev-transit" onClick={() => onRoute(ev)}>
                        <Train size={12} /> 乗換案内
                      </button>
                    )}
                    <label className="hub-ev-remind" title="開始の何分前に知らせるか">
                      <Bell size={12} />
                      <select
                        value={ev.remind == null ? 30 : ev.remind}
                        onChange={(e) => updateEvent(ev.id, { remind: Number(e.target.value) })}
                      >
                        {REMIND_OPTIONS.map((m) => (
                          <option key={m} value={m}>{remindLabel(m)}</option>
                        ))}
                      </select>
                    </label>
                    <button className="hub-ev-ics" onClick={() => downloadICS(ev)}
                      title="端末カレンダーに追加（.ics）。閉じていても通知が鳴ります">
                      <CalendarPlus size={12} /> カレンダーに保存
                    </button>
                  </div>
                </div>
                <div className="hub-ev-side">
                  {delId === ev.id ? (
                    <div className="hub-ev-confirm">
                      <span>削除する範囲</span>
                      <button className="hub-ev-cf"
                        onClick={() => {
                          updateEvent(ev.id, { exdates: [...(ev.exdates || []), ev.date] });
                          setDelId(null);
                        }}>この日だけ</button>
                      <button className="hub-ev-cf yes"
                        onClick={() => { removeEvent(ev.id); setDelId(null); }}>すべて</button>
                      <button className="hub-ev-cf" onClick={() => setDelId(null)}>取消</button>
                    </div>
                  ) : (
                    <>
                      <button className="hub-iconbtn faint" aria-label="編集"
                        title="この予定を編集"
                        onClick={() => setEditing(events.find((e) => e.id === ev.id) || ev)}>
                        <Pencil size={15} />
                      </button>
                      <button className="hub-iconbtn faint" onClick={() => addTemplate(ev)}
                        title="よく使う予定に登録（別の日に再追加できます）" aria-label="よく使う予定に登録">
                        <Star size={15} />
                      </button>
                      <button className="hub-iconbtn faint" aria-label="削除"
                        onClick={() => {
                          if (ev.repeat && ev.repeat !== "none") setDelId(ev.id);
                          else removeEvent(ev.id);
                        }}>
                        <Trash2 size={15} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* よく使う予定（テンプレート）から再追加 */}
      <div className="hub-tpl">
        <div className="hub-tpl-head">
          <span className="hub-tpl-eyebrow"><Repeat size={12} /> よく使う予定</span>
          {templates.length > 0 && (
            <button className="hub-tpl-manage" onClick={() => setManageTpl((v) => !v)}>
              {manageTpl ? "完了" : "編集"}
            </button>
          )}
        </div>
        {templates.length === 0 ? (
          <p className="hub-tpl-empty">登録した予定を「星マーク」でここに保存しておくと、選んだ日にワンタップで追加できます。</p>
        ) : (
          <div className="hub-tpl-chips">
            {templates.map((tpl) => (
              <div key={tpl.id} className="hub-chip">
                <button className="hub-chip-add" onClick={() => addFromTemplate(tpl)}
                  title={`${selectedDate} に追加`}>
                  {!manageTpl && <Plus size={13} />}
                  <span className="hub-chip-title">{tpl.title}</span>
                  {tpl.start && <span className="hub-chip-time">{tpl.start}</span>}
                </button>
                {manageTpl && (
                  <button className="hub-chip-del" onClick={() => removeTemplate(tpl.id)} aria-label="テンプレを削除">
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => pad(i));
const MINUTES = Array.from({ length: 60 }, (_, i) => pad(i));
/* 「時」「分」の2つのプルダウン。分は1分刻み。未選択（指定なし）は "" を返す */
function TimeSelect({ value, onChange }) {
  const [h, m] = value ? value.split(":") : ["", ""];
  const setH = (nh) => onChange(nh === "" ? "" : `${nh}:${m || "00"}`);
  const setM = (nm) => onChange(`${h || "00"}:${nm}`);
  return (
    <div className="hub-time2">
      <select className="hub-di" value={h} onChange={(e) => setH(e.target.value)}>
        <option value="">時</option>
        {HOURS.map((x) => <option key={x} value={x}>{x}時</option>)}
      </select>
      <select className="hub-di" value={m} onChange={(e) => setM(e.target.value)}>
        <option value="">分</option>
        {MINUTES.map((x) => <option key={x} value={x}>{x}分</option>)}
      </select>
    </div>
  );
}

function ManualForm({ defaultDate, initial, home, categories = [], onSubmit, onClose }) {
  const isEdit = !!initial;
  const [f, setF] = useState(initial ? {
    title: initial.title || "", date: initial.date || defaultDate, start: initial.start || "",
    end: initial.end || "", location: initial.location || "", travelMin: initial.travelMin ?? 30,
    remind: initial.remind ?? 30, repeat: initial.repeat || "none", cat: initial.cat || DEFAULT_CAT, notes: initial.notes || "",
  } : {
    title: "", date: defaultDate, start: "", end: "", location: "", travelMin: 30, remind: 30, repeat: "none", cat: DEFAULT_CAT, notes: "",
  });
  const [asTemplate, setAsTemplate] = useState(false);
  const [lk, setLk] = useState({ state: "idle", transit: null });
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));

  /* 電車・バスの所要時間の「目安」をWeb検索で調べる（車の計算は精度が出ないため廃止） */
  const lookupTravel = async () => {
    if (!f.location.trim() || !home) return;
    setLk({ state: "loading", transit: null });
    try {
      const r = await suggestRoute(home, f.location);
      const t = Number(r.totalMinutes) || null;
      setLk(t ? { state: "done", transit: t } : { state: "error", transit: null });
    } catch (e) {
      setLk({ state: "error", transit: null });
    }
  };

  const submit = () => {
    if (!f.title.trim()) return;
    onSubmit({ ...f, travelMin: Number(f.travelMin) || 0, remind: Number(f.remind) }, asTemplate);
  };
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="hub-modal-backdrop" onClick={onClose}>
      <div className="hub-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={isEdit ? "予定を編集" : "予定を追加"}>
        <div className="hub-modal-head">
          <div className="hub-eyebrow">{isEdit ? "予定を編集" : "予定を追加"}</div>
          <button className="hub-modal-close" onClick={onClose} aria-label="閉じる"><X size={18} /></button>
        </div>
        <div className="hub-form-fields">
          <input className="hub-di title" placeholder="タイトル" value={f.title}
            onChange={(e) => set("title", e.target.value)} autoFocus />
          {categories.length > 0 && (
            <div className="hub-catpick">
              {categories.map((c) => (
                <button key={c.id} type="button"
                  className={"hub-catpill" + (f.cat === c.id ? " on" : "")}
                  style={f.cat === c.id ? { background: c.color, borderColor: c.color } : { borderColor: c.color, color: c.color }}
                  onClick={() => set("cat", c.id)}>
                  <span className="hub-catdot" style={{ background: f.cat === c.id ? "#fff" : c.color }} />{c.name}
                </button>
              ))}
            </div>
          )}
          <input className="hub-di" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} />
          <label className="hub-time-row"><span>開始</span><TimeSelect value={f.start} onChange={(v) => set("start", v)} /></label>
          <label className="hub-time-row"><span>終了</span><TimeSelect value={f.end} onChange={(v) => set("end", v)} /></label>
          <div className="hub-di-row">
            <input className="hub-di grow" placeholder="場所（駅名など）" value={f.location}
              onChange={(e) => set("location", e.target.value)} />
            <div className="hub-di-travel">
              <input className="hub-di" type="number" min="0" value={f.travelMin}
                onChange={(e) => set("travelMin", e.target.value)} />
              <span>分</span>
            </div>
          </div>
          <div className="hub-lookup">
            {!home ? (
              <p className="hub-lookup-note">
                移動時間を自動で調べるには、出発ゲートで出発地を登録してください。
              </p>
            ) : (
              <>
                <button className="hub-ghostbtn wide" onClick={lookupTravel}
                  disabled={!f.location.trim() || lk.state === "loading"}>
                  {lk.state === "loading"
                    ? <><Loader2 size={14} className="spin" /> 調べています…</>
                    : <><Train size={14} /> {home} からの所要時間を調べる（電車・バス）</>}
                </button>
                {lk.state === "error" && (
                  <div className="hub-note err">所要時間を取得できませんでした。手入力してください。</div>
                )}
                {lk.state === "done" && lk.transit != null && (
                  <div className="hub-lookup-res">
                    <button className="hub-lookup-opt" onClick={() => set("travelMin", lk.transit)}>
                      <Train size={13} /> 電車・バス 約{lk.transit}分 <span className="hub-lookup-apply">反映</span>
                    </button>
                    <p className="hub-lookup-note">
                      ※ Web検索による目安です。正確な時刻は乗換案内で確認してください。
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          <label className="hub-di-remind">
            <Bell size={13} /> リマインド
            <select className="hub-di" value={f.remind} onChange={(e) => set("remind", e.target.value)}>
              {REMIND_OPTIONS.map((m) => (
                <option key={m} value={m}>{remindLabel(m)}</option>
              ))}
            </select>
          </label>
          <label className="hub-di-remind">
            <Repeat size={13} /> 繰り返し
            <select className="hub-di" value={f.repeat} onChange={(e) => set("repeat", e.target.value)}>
              {REPEAT_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="hub-tpl-check">
            <input type="checkbox" checked={asTemplate} onChange={(e) => setAsTemplate(e.target.checked)} />
            <Star size={13} /> よく使う予定にも登録する
          </label>
          <button className="hub-primary full" onClick={submit}>
            {isEdit ? <><Check size={15} /> 保存</> : <><Plus size={15} /> 追加する</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   地点と天気
   ============================================================ */
function WeatherCard({ title, sub, data, loading, onRemove, isCurrent }) {
  const info = data && !data.error ? weatherInfo(data.code) : null;
  const Icon = info ? info.Icon : Cloud;
  return (
    <div className={"hub-wx-card" + (isCurrent ? " current" : "")}>
      {onRemove && (
        <button className="hub-wx-del" onClick={onRemove} aria-label="地点を削除"><X size={13} /></button>
      )}
      <div className="hub-wx-name">
        {isCurrent && <Navigation size={12} />} {title}
        {sub && <span className="hub-wx-sub">{sub}</span>}
      </div>
      {loading ? (
        <div className="hub-wx-loading"><Loader2 size={18} className="spin" /></div>
      ) : data && data.error ? (
        <div className="hub-wx-err">取得できません</div>
      ) : data ? (
        <>
          <div className="hub-wx-main">
            <Icon size={34} style={{ color: info.color }} />
            <span className="hub-wx-temp">{data.temp}<small>°</small></span>
          </div>
          <div className="hub-wx-meta">
            <span className="hub-wx-cond">{info.label}</span>
            <span className="hub-wx-range">
              <span style={{ color: "var(--rush)" }}>{data.max}°</span> / <span style={{ color: "var(--accent)" }}>{data.min}°</span>
            </span>
          </div>
          <div className="hub-wx-sub2">湿度 {data.humidity}%・風 {data.wind}km/h</div>
        </>
      ) : (
        <div className="hub-wx-loading"><Loader2 size={18} className="spin" /></div>
      )}
    </div>
  );
}

function WeatherPanel({ places, addPlace, removePlace }) {
  const [wx, setWx] = useState({});          // placeId -> data|{error}
  const [loadingIds, setLoadingIds] = useState({});
  const [current, setCurrent] = useState(null);
  const [curState, setCurState] = useState("idle"); // idle|loading|ok|denied|error
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState(false);

  const loadFor = async (place) => {
    setLoadingIds((s) => ({ ...s, [place.id]: true }));
    try {
      const d = await fetchWeather(place.lat, place.lng);
      setWx((s) => ({ ...s, [place.id]: d }));
    } catch (e) {
      setWx((s) => ({ ...s, [place.id]: { error: true } }));
    } finally {
      setLoadingIds((s) => ({ ...s, [place.id]: false }));
    }
  };

  useEffect(() => {
    places.forEach((p) => { if (wx[p.id] === undefined && !loadingIds[p.id]) loadFor(p); });
    // eslint-disable-next-line
  }, [places]);

  const refreshAll = () => {
    places.forEach(loadFor);
    if (curState === "ok") getCurrent();
  };

  const getCurrent = () => {
    if (!("geolocation" in navigator)) { setCurState("error"); return; }
    setCurState("loading");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const d = await fetchWeather(pos.coords.latitude, pos.coords.longitude);
          setCurrent(d); setCurState("ok");
        } catch (e) { setCurState("error"); }
      },
      () => setCurState("denied"),
      { timeout: 10000, maximumAge: 300000 }
    );
  };

  const submitAdd = async () => {
    const q = name.trim();
    if (!q) return;
    setAddErr(""); setBusy(true);
    try {
      const g = await geocodePlace(q);
      if (!g) { setAddErr("地点が見つかりませんでした。駅名や市区町村名で試してください。"); return; }
      addPlace({ name: g.name, lat: g.lat, lng: g.lng });
      setName(""); setAdding(false);
    } catch (e) {
      setAddErr("検索に失敗しました。ネットワークをご確認ください。");
    } finally { setBusy(false); }
  };

  return (
    <div className="hub-card">
      <div className="hub-wx-head">
        <div className="hub-eyebrow">地点と天気</div>
        <div className="hub-wx-actions">
          <button className="hub-ghostbtn" onClick={refreshAll} title="更新"><RefreshCw size={14} /> 更新</button>
          <button className="hub-ghostbtn" onClick={() => setAdding((v) => !v)}><Plus size={14} /> 地点を追加</button>
        </div>
      </div>

      {adding && (
        <div className="hub-form">
          <div className="hub-di-row">
            <input className="hub-di grow" placeholder="駅名・市区町村名（例：横浜、梅田）" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }} autoFocus />
            <button className="hub-primary" onClick={submitAdd} disabled={busy}>
              {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />} 追加
            </button>
          </div>
          {addErr && <div className="hub-note err">{addErr}</div>}
        </div>
      )}

      <div className="hub-wx-grid">
        {/* 現在地 */}
        {curState === "ok" && current ? (
          <WeatherCard title="現在地" data={current} isCurrent />
        ) : (
          <button className="hub-wx-card getcur" onClick={getCurrent} disabled={curState === "loading"}>
            <Navigation size={20} />
            <span>
              {curState === "loading" ? "現在地を取得中…"
                : curState === "denied" ? "位置情報が許可されていません"
                : curState === "error" ? "現在地を取得できません"
                : "現在地の天気を見る"}
            </span>
          </button>
        )}
        {/* 登録地点 */}
        {places.map((p) => (
          <WeatherCard
            key={p.id} title={p.name} data={wx[p.id]} loading={!!loadingIds[p.id]}
            onRemove={() => removePlace(p.id)}
          />
        ))}
      </div>
      <p className="hub-wx-note">天気データ：Open-Meteo。現在地は端末の位置情報の許可が必要です。</p>
    </div>
  );
}

/* ============================================================
   ショートカット
   ============================================================ */
function ShortcutPanel({ shortcuts, setShortcuts }) {
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState({ name: "", url: "", color: "#3D6CA6" });
  const palette = ["#C24B3C", "#2F7D5B", "#3D6CA6", "#C98A2B", "#232F42", "#7A4DA0"];

  const add = () => {
    let url = nf.url.trim();
    if (!url) return;
    if (!/^https?:\/\//.test(url) && !url.includes("://")) url = "https://" + url;
    setShortcuts((p) => [...p, { id: uid(), name: nf.name.trim() || url, url, color: nf.color }]);
    setNf({ name: "", url: "", color: "#3D6CA6" });
    setAdding(false);
  };
  const remove = (id) => setShortcuts((p) => p.filter((s) => s.id !== id));

  return (
    <div className="hub-card">
      <div className="hub-eyebrow">ショートカット</div>
      <div className="hub-sc-head">
        <h2 className="hub-day-title">よく使うアプリ</h2>
        <button className="hub-ghostbtn" onClick={() => setAdding((v) => !v)}>
          <Plus size={15} /> 追加
        </button>
      </div>

      {adding && (
        <div className="hub-form">
          <input className="hub-di title" placeholder="名前（例：仕事メール）" value={nf.name}
            onChange={(e) => setNf({ ...nf, name: e.target.value })} autoFocus />
          <input className="hub-di" placeholder="URL または アプリのリンク" value={nf.url}
            onChange={(e) => setNf({ ...nf, url: e.target.value })} />
          <div className="hub-swatches">
            {palette.map((c) => (
              <button key={c} className={"hub-swatch" + (nf.color === c ? " on" : "")}
                style={{ background: c }} onClick={() => setNf({ ...nf, color: c })} aria-label="色" />
            ))}
          </div>
          <button className="hub-primary full" onClick={add}><Check size={15} /> 保存</button>
        </div>
      )}

      <div className="hub-sc-grid">
        {shortcuts.map((s) => (
          <div key={s.id} className="hub-sc-tile">
            <button className="hub-sc-del" onClick={() => remove(s.id)} aria-label="削除"><X size={12} /></button>
            <a href={s.url} target="_blank" rel="noreferrer" className="hub-sc-link">
              <span className="hub-sc-icon" style={{ background: s.color }}>
                {s.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="hub-sc-name">{s.name}</span>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   スタイル
   ============================================================ */
const CSS = `
:root{
  --ink:#17202E; --ink-2:#232F42; --paper:#F0EBE0; --card:#FBF8F1;
  --line:#E0D8C7; --text:#1D2430; --muted:#75726A;
  --go:#2F7D5B; --soon:#C98A2B; --rush:#C24B3C; --accent:#3D6CA6;
  --mono:"SFMono-Regular",ui-monospace,"Roboto Mono","DejaVu Sans Mono",monospace;
  --sans:"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP",system-ui,-apple-system,sans-serif;
}
.hub-root{ font-family:var(--sans); color:var(--text); background:
  radial-gradient(120% 80% at 50% -10%, #F6F2E9 0%, var(--paper) 55%) fixed;
  min-height:100vh; -webkit-font-smoothing:antialiased; }
.hub-root *{ box-sizing:border-box; }

/* ---- ログイン / 設定画面 ---- */
.hub-auth-wrap{ min-height:100vh; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:24px; }
.hub-auth{ width:100%; max-width:360px; background:var(--card); border:1px solid var(--line); border-radius:16px;
  padding:26px 22px; display:flex; flex-direction:column; gap:11px; box-shadow:0 12px 40px rgba(20,28,42,.14); }
.hub-auth.wide{ max-width:560px; }
.hub-auth-logo{ font-family:var(--mono); font-weight:700; font-size:26px; letter-spacing:.22em; text-align:center; }
.hub-auth-sub{ text-align:center; font-size:13px; color:var(--muted); margin-bottom:6px; }
.hub-auth-switch{ background:transparent; border:0; color:var(--accent); font-size:13px; cursor:pointer; padding:4px; }
.hub-auth-switch:hover{ text-decoration:underline; }
.hub-setup-p{ font-size:13px; line-height:1.7; color:var(--text); margin:4px 0; }
.hub-setup-sql{ background:#0c121b; color:#EDE7DA; border-radius:10px; padding:12px 14px; font-family:var(--mono);
  font-size:11.5px; line-height:1.5; overflow-x:auto; white-space:pre; }

/* ---- ダークモード ---- */
.hub-root.dark{
  --ink:#0A1017; --ink-2:#1B2530; --paper:#0E141C; --card:#161E27; --line:#2A343F;
  --text:#E6EAEF; --muted:#9AA4AE; --go:#3E9B72; --soon:#D6A24A; --rush:#D96B5C; --accent:#5A8FCB;
  background:radial-gradient(120% 80% at 50% -10%, #141d27 0%, var(--paper) 55%) fixed;
}
.hub-root.dark .hub-di,
.hub-root.dark .hub-chip,
.hub-root.dark .hub-form,
.hub-root.dark .hub-draft,
.hub-root.dark .hub-te-ctl .hub-iconbtn{ background:#0F1822; color:var(--text); border-color:var(--line); }
.hub-root.dark .hub-di option{ background:#0F1822; color:var(--text); }
.hub-root.dark .hub-iconbtn:hover,
.hub-root.dark .hub-day:hover,
.hub-root.dark .hub-modal-close:hover,
.hub-root.dark .hub-sc-link:hover,
.hub-root.dark .hub-chip-add:hover,
.hub-root.dark .hub-wx-card.getcur:hover,
.hub-root.dark .hub-sc-del,
.hub-root.dark .hub-wx-card:hover .hub-wx-del{ background:#212D3A; }
.hub-root.dark .hub-tpl,
.hub-root.dark .hub-travel-edit,
.hub-root.dark .hub-ai-summary,
.hub-root.dark .hub-ai-note{ background:#111922; }
.hub-root.dark .hub-wx-card.current{ background:#122234; border-color:#25384c; }
.hub-root.dark .hub-note.loading{ background:#152230; }
.hub-root.dark .hub-note.err,
.hub-root.dark .hub-chip-del{ background:#2A1A1A; }
.hub-root.dark .hub-ev-repeat{ background:#16283A; }
.hub-root.dark .hub-ev-ics:hover{ background:#132A20; }
.hub-root.dark .hub-ev-leave.lv-go{ background:rgba(62,155,114,.18); }
.hub-root.dark .hub-ev-leave.lv-soon{ background:rgba(214,162,74,.18); color:#E0B566; }
.hub-root.dark .hub-ev-leave.lv-rush{ background:rgba(217,107,92,.18); }
.hub-root.dark .hub-primary{ background:var(--accent); color:#fff; }
.hub-root.dark .hub-primary:hover{ background:var(--accent); filter:brightness(1.1); }
.hub-root.dark .hub-day.sel{ background:var(--accent); }
.hub-root.dark .hub-day.sel .hub-daynum{ color:#fff; }
.hub-root.dark .hub-day.sel .hub-dot{ background:#fff; }
.hub-root.dark .hub-card{ box-shadow:none; }
.hub-root.dark .hub-ev-remind select,
.hub-root.dark select.hub-di{ background:#0F1822; color:var(--text); border-color:var(--line); }
.hub-root.dark .hub-ev-remind select option,
.hub-root.dark select.hub-di option{ background:#0F1822; color:var(--text); }
.hub-root.dark .hub-od-chip{ background:#0F1822; border-color:var(--line); color:var(--text); }
.spin{ animation:hubspin 1s linear infinite; }
@keyframes hubspin{ to{ transform:rotate(360deg); } }
@media (prefers-reduced-motion: reduce){ .spin{ animation:none; } }

/* ---- ツールバー ---- */
.hub-bar{ display:flex; align-items:center; gap:16px; padding:14px 24px;
  background:var(--ink); color:#F0EBE0; position:sticky; top:0; z-index:20;
  border-bottom:2px solid #0d141e; }
.hub-brand{ display:flex; align-items:baseline; gap:10px; }
.hub-logo{ font-family:var(--mono); font-weight:700; font-size:22px; letter-spacing:.22em;
  color:#F0EBE0; padding-right:2px; }
.hub-tag{ font-size:12px; color:#9aa6b6; letter-spacing:.02em; }
.hub-clock{ margin-left:auto; font-family:var(--mono); font-size:20px; letter-spacing:.14em;
  color:#EBD9A8; font-variant-numeric:tabular-nums; }
.hub-sync{ display:inline-flex; align-items:center; color:#8ea0b6; }
.hub-pb-brand .hub-sync{ margin-left:2px; }
.hub-modeswitch{ display:flex; background:#0f1621; border-radius:999px; padding:3px; gap:2px; }
.hub-modebtn{ display:flex; align-items:center; gap:6px; border:0; background:transparent;
  color:#9aa6b6; font-family:var(--sans); font-size:13px; padding:7px 14px; border-radius:999px;
  cursor:pointer; transition:.15s; }
.hub-modebtn.on{ background:#F0EBE0; color:var(--ink); font-weight:700; }
.hub-modebtn:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }
.hub-bar.is-mobile .hub-tag{ display:none; }

/* ---- 出発ゲート ---- */
.hub-gate{ margin:22px 24px; background:var(--ink); color:#EDE7DA; border-radius:14px;
  padding:18px 22px; box-shadow:0 10px 30px rgba(20,28,42,.22);
  border:1px solid #0d141e; position:relative; overflow:hidden; }
.hub-gate::before{ content:""; position:absolute; inset:0 0 auto 0; height:5px;
  background:repeating-linear-gradient(90deg,#EBD9A8 0 14px, transparent 14px 22px); opacity:.5; }
.hub-gate.lv-go::before{ background:repeating-linear-gradient(90deg,var(--go) 0 14px,transparent 14px 22px); }
.hub-gate.lv-soon::before{ background:repeating-linear-gradient(90deg,var(--soon) 0 14px,transparent 14px 22px); }
.hub-gate.lv-rush::before{ background:repeating-linear-gradient(90deg,var(--rush) 0 14px,transparent 14px 22px); }
.hub-gate-eyebrow{ font-family:var(--mono); font-size:11px; letter-spacing:.24em; text-transform:uppercase;
  color:#8ea0b6; display:flex; align-items:center; gap:9px; margin-bottom:14px; }
.hub-signal{ width:9px; height:9px; border-radius:50%; display:inline-block; box-shadow:0 0 9px currentColor; }
.hub-signal[data-lv=go]{ background:var(--go); color:var(--go); }
.hub-signal[data-lv=soon]{ background:var(--soon); color:var(--soon); }
.hub-signal[data-lv=rush]{ background:var(--rush); color:var(--rush);
  animation:hubpulse 1.1s ease-in-out infinite; }
@keyframes hubpulse{ 50%{ opacity:.35; } }
.hub-signal.sm{ width:7px; height:7px; box-shadow:0 0 6px currentColor; }
.hub-gate-body{ display:flex; gap:22px; align-items:stretch; justify-content:space-between; flex-wrap:wrap; }
.hub-gate-left{ min-width:0; flex:1 1 240px; }
.hub-gate-title{ font-size:22px; font-weight:700; letter-spacing:.01em; margin-bottom:10px;
  color:#F5F0E4; line-height:1.25; }
.hub-gate.big .hub-gate-title{ font-size:26px; }
.hub-gate-cat{ display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:8px; vertical-align:middle; }
.hub-gate-route{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; color:#c3ccd8; }
.hub-origin,.hub-dest{ display:inline-flex; align-items:center; gap:5px; }
.hub-origin{ background:#0f1621; border:1px solid #2a3648; color:#c3ccd8; padding:5px 10px;
  border-radius:8px; cursor:pointer; font-family:var(--sans); font-size:13px; }
.hub-origin:hover{ border-color:var(--accent); }
.hub-origin.unset{ border-style:dashed; border-color:var(--soon); color:#EBD9A8; }
.hub-gate-hint{ font-size:11px; color:#7d8ba0; }
.hub-origin-input{ background:#0f1621; border:1px solid var(--accent); color:#EDE7DA; padding:5px 10px;
  border-radius:8px; font-family:var(--sans); font-size:13px; width:150px; }
.hub-arrow{ color:#5f6f84; }
.hub-dest{ background:#0f1621; border:1px solid #2a3648; padding:5px 10px; border-radius:8px; }
.hub-gate-links{ display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
.hub-link{ display:inline-flex; align-items:center; gap:6px; background:var(--accent); color:#fff;
  text-decoration:none; padding:8px 14px; border-radius:8px; font-size:13px; font-weight:600; }
.hub-link:hover{ filter:brightness(1.08); }
.hub-link.ghost{ background:transparent; border:1px solid #34425a; color:#c3ccd8; font-weight:500; }
.hub-gate-right{ flex:0 0 auto; text-align:right; display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
.hub-board{ background:#0c121b; border:1px solid #263349; border-radius:10px;
  padding:10px 16px; display:inline-block; }
.hub-board-row{ display:flex; align-items:baseline; gap:12px; justify-content:space-between; }
.hub-board-k{ font-family:var(--mono); font-size:10px; letter-spacing:.2em; color:#7d8ba0; }
.hub-board-t{ font-family:var(--mono); font-size:40px; font-weight:700; color:#EBD9A8;
  letter-spacing:.04em; font-variant-numeric:tabular-nums; line-height:1.05; }
.hub-board-t.sm{ font-size:20px; color:#9aa6b6; }
.hub-board-row.muted{ margin-top:2px; }
.hub-countdown{ font-size:15px; font-weight:700; color:#F5F0E4; margin-top:8px; }
.hub-traveltag{ font-size:11px; color:#7d8ba0; font-family:var(--mono); letter-spacing:.02em; }
.hub-gate.empty .hub-gate-empty{ font-size:15px; color:#9aa6b6; padding:8px 0 4px; }

/* ---- レイアウト ---- */
.hub-desk{ padding:0 0 40px; }
.hub-grid{ display:grid; grid-template-columns: 1.05fr 1fr; gap:20px; padding:0 24px; align-items:start; }
@media (max-width: 760px){ .hub-grid{ grid-template-columns:1fr; } }

/* ショートカットは常に最下部・全幅（右カラムに置かない） */
.hub-desk-apps{ padding:20px 24px 0; }
.hub-desk-apps .hub-sc-grid{ grid-template-columns:repeat(auto-fill, minmax(92px, 1fr)); }
@media (max-width: 560px){ .hub-desk-apps{ padding:16px 14px 0; } }

/* ---- 地点と天気 ---- */
.hub-wx-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; gap:10px; flex-wrap:wrap; }
.hub-wx-actions{ display:flex; gap:8px; }
.hub-wx-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:12px; }
.hub-wx-card{ position:relative; background:var(--card); border:1px solid var(--line); border-radius:12px;
  padding:13px; display:flex; flex-direction:column; gap:4px; min-height:120px; }
.hub-wx-card.current{ background:#eef2f6; border-color:#cdd8e4; }
.hub-wx-name{ font-size:12.5px; font-weight:700; display:flex; align-items:center; gap:4px; }
.hub-wx-sub{ font-size:11px; color:var(--muted); font-weight:500; margin-left:2px; }
.hub-wx-main{ display:flex; align-items:center; gap:10px; margin-top:2px; }
.hub-wx-temp{ font-family:var(--mono); font-size:32px; font-weight:700; font-variant-numeric:tabular-nums; }
.hub-wx-temp small{ font-size:16px; color:var(--muted); }
.hub-wx-meta{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
.hub-wx-cond{ font-size:12px; font-weight:600; }
.hub-wx-range{ font-family:var(--mono); font-size:12px; font-weight:700; }
.hub-wx-sub2{ font-size:11px; color:var(--muted); }
.hub-wx-loading{ flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted); }
.hub-wx-err{ flex:1; display:flex; align-items:center; color:var(--rush); font-size:12px; }
.hub-wx-del{ position:absolute; top:6px; right:6px; width:20px; height:20px; border-radius:50%; border:0;
  background:transparent; color:var(--muted); cursor:pointer; display:flex; align-items:center; justify-content:center; }
.hub-wx-card:hover .hub-wx-del{ background:#efe9dc; }
.hub-wx-del:hover{ color:var(--rush); }
.hub-wx-card.getcur{ align-items:center; justify-content:center; text-align:center; gap:8px; color:var(--accent);
  cursor:pointer; border-style:dashed; font-size:13px; font-weight:600; font-family:var(--sans); }
.hub-wx-card.getcur:hover{ background:#eef2f6; }
.hub-wx-card.getcur:disabled{ opacity:.6; cursor:default; }
.hub-wx-note{ font-size:11px; color:var(--muted); margin:10px 2px 0; }


/* ---- カード共通 ---- */
.hub-card{ background:var(--card); border:1px solid var(--line); border-radius:14px;
  padding:18px; box-shadow:0 2px 0 rgba(224,216,199,.5); }
.hub-eyebrow{ font-family:var(--mono); font-size:10px; letter-spacing:.24em; text-transform:uppercase;
  color:var(--muted); margin-bottom:12px; }
.hub-day-title{ font-size:16px; font-weight:700; margin:0; letter-spacing:.01em; }
.hub-iconbtn{ background:transparent; border:1px solid transparent; border-radius:8px; padding:6px;
  cursor:pointer; color:var(--text); display:inline-flex; align-items:center; justify-content:center; }
.hub-iconbtn:hover{ background:#efe9dc; }
.hub-iconbtn.faint{ color:#b3aa98; }
.hub-iconbtn.faint:hover{ color:var(--rush); background:#f6e7e3; }
.hub-iconbtn:focus-visible,.hub-primary:focus-visible,.hub-ghostbtn:focus-visible,.hub-day:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px; }

.hub-primary{ display:inline-flex; align-items:center; gap:6px; background:var(--ink); color:#F0EBE0;
  border:0; border-radius:9px; padding:9px 13px; font-family:var(--sans); font-size:13px; font-weight:600;
  cursor:pointer; }
.hub-primary:hover{ background:#20293a; }
.hub-primary.sm{ padding:7px 11px; font-size:12px; }
.hub-primary.full{ width:100%; justify-content:center; margin-top:10px; }
.hub-ghostbtn{ display:inline-flex; align-items:center; gap:6px; background:transparent; color:var(--text);
  border:1px solid var(--line); border-radius:9px; padding:8px 12px; font-family:var(--sans); font-size:13px;
  cursor:pointer; }
.hub-ghostbtn:hover{ border-color:var(--muted); }

/* ---- カレンダー ---- */
.hub-cal-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
.hub-cal-month{ font-size:18px; font-weight:700; font-family:var(--mono); letter-spacing:.03em; }
.hub-cal-month span{ font-family:var(--sans); font-size:12px; color:var(--muted); margin:0 2px 0 1px; font-weight:500; }
.hub-cal-grid{ display:grid; grid-template-columns:repeat(7,1fr); gap:4px; }
.hub-cal-wd{ margin-bottom:6px; }
.hub-wd{ text-align:center; font-size:11px; color:var(--muted); font-weight:600; padding:4px 0; }
.hub-wd.sun{ color:var(--rush); } .hub-wd.sat{ color:var(--accent); }
.hub-day{ position:relative; aspect-ratio:1/1; border:1px solid transparent; background:transparent;
  border-radius:9px; cursor:pointer; display:flex; align-items:center; justify-content:center;
  font-family:var(--mono); font-size:14px; color:var(--text); font-variant-numeric:tabular-nums; }
.hub-day.empty{ cursor:default; }
.hub-day:hover:not(.empty){ background:#efe9dc; }
.hub-day.sun .hub-daynum{ color:var(--rush); } .hub-day.sat .hub-daynum{ color:var(--accent); }
.hub-day.today{ border-color:var(--soon); }
.hub-day.sel{ background:var(--ink); }
.hub-day.sel .hub-daynum{ color:#F0EBE0; }
.hub-dots{ position:absolute; bottom:5px; left:0; right:0; display:flex; justify-content:center; gap:3px; }
.hub-dot{ width:5px; height:5px; border-radius:50%; background:var(--go); }
.hub-catfilter{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
.hub-catbox{ margin-bottom:2px; }
.hub-catwrap{ position:relative; display:inline-flex; }
.hub-catdel{ position:absolute; top:-5px; right:-5px; width:17px; height:17px; border-radius:50%; border:0;
  background:var(--rush); color:#fff; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.hub-catedit{ background:transparent; border:1px dashed var(--line); border-radius:999px; padding:4px 11px;
  font-size:12px; font-weight:600; color:var(--muted); cursor:pointer; }
.hub-catedit:hover{ border-color:var(--accent); color:var(--accent); }
.hub-catadd{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; background:#f4efe4; border:1px solid var(--line);
  border-radius:11px; padding:10px 11px; margin-bottom:12px; }
.hub-catadd .hub-di{ flex:1 1 130px; }
.hub-root.dark .hub-catadd{ background:#111922; }
.hub-catpill{ display:inline-flex; align-items:center; gap:5px; border:1.5px solid var(--line); background:transparent;
  border-radius:999px; padding:4px 11px; font-family:var(--sans); font-size:12px; font-weight:600; cursor:pointer;
  opacity:.55; }
.hub-catpill.on{ color:#fff; opacity:1; }
.hub-catdot{ width:8px; height:8px; border-radius:50%; }

/* ---- 予定リスト ---- */
.hub-day-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
.hub-day-actions{ display:flex; gap:8px; }
.hub-note{ font-size:13px; padding:10px 12px; border-radius:9px; margin-bottom:10px; display:flex; align-items:center; gap:8px; }
.hub-note.loading{ background:#eef1f5; color:var(--accent); }
.hub-note.err{ background:#f8ebe8; color:var(--rush); }
.hub-empty-day{ font-size:13px; color:var(--muted); line-height:1.7; padding:14px 4px; border-top:1px dashed var(--line); margin-top:6px; }

.hub-evlist{ list-style:none; margin:6px 0 0; padding:0; display:flex; flex-direction:column; gap:2px; }
.hub-ev{ display:flex; gap:12px; padding:12px 4px; border-top:1px solid var(--line); align-items:flex-start; }
.hub-ev-time{ font-family:var(--mono); text-align:right; min-width:52px; flex:0 0 auto; }
.hub-ev-start{ display:block; font-size:16px; font-weight:700; font-variant-numeric:tabular-nums; }
.hub-ev-allday{ display:inline-block; font-size:11px; font-weight:700; color:var(--muted);
  background:var(--line); border-radius:6px; padding:2px 6px; }
.hub-ev-end{ font-size:11px; color:var(--muted); }
.hub-ev-main{ flex:1 1 auto; min-width:0; }
.hub-ev-cat{ align-self:stretch; width:3px; border-radius:3px; flex:0 0 auto; }
.hub-ev-cattag{ display:inline-block; font-size:10px; font-weight:700; border:1px solid; border-radius:6px;
  padding:0 6px; margin-left:8px; vertical-align:middle; }
.hub-catpick{ display:flex; flex-wrap:wrap; gap:6px; }
.hub-ev-title{ font-size:14px; font-weight:600; }
.hub-ev-loc{ font-size:12px; color:var(--muted); display:flex; align-items:center; gap:4px; margin-top:3px; }
.hub-ev-travel{ color:#a49c8b; }
.hub-ev-leave{ display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; margin-top:6px;
  padding:3px 9px; border-radius:999px; }
.hub-ev-leave.lv-go{ background:#e7f0eb; color:var(--go); }
.hub-ev-leave.lv-soon{ background:#f6efe0; color:#a6741f; }
.hub-ev-leave.lv-rush{ background:#f8e7e4; color:var(--rush); }
.hub-ev-transit{ display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--accent);
  text-decoration:none; margin-top:8px; }
.hub-ev-transit:hover{ text-decoration:underline; }

/* ---- フォーム / 下書き ---- */
.hub-form,.hub-draft{ background:#fff; border:1px solid var(--line); border-radius:11px; padding:12px;
  margin:6px 0 12px; display:flex; flex-direction:column; gap:8px; }
.hub-draft{ border-left:3px solid var(--soon); }
.hub-draft-badge{ display:inline-flex; align-items:center; gap:5px; font-size:11px; color:#a6741f;
  font-weight:700; letter-spacing:.02em; }
.hub-form-head{ display:flex; align-items:center; justify-content:space-between; font-size:13px; font-weight:700; }
.hub-form-fields{ display:flex; flex-direction:column; gap:9px; }
.hub-time-row{ display:flex; align-items:center; gap:10px; font-size:13px; color:var(--muted); }
.hub-time-row > span{ min-width:32px; }
.hub-time2{ display:flex; gap:6px; flex:1; }
.hub-time2 select{ flex:1; cursor:pointer; }

/* 移動時間の自動検索 */
.hub-lookup{ display:flex; flex-direction:column; gap:8px; }
.hub-lookup-res{ display:flex; flex-direction:column; gap:6px; }
.hub-lookup-opt{ display:flex; align-items:center; gap:7px; background:#f4efe4; border:1px solid var(--line);
  border-radius:9px; padding:9px 12px; font-family:var(--sans); font-size:13px; font-weight:600; color:var(--text);
  cursor:pointer; }
.hub-lookup-opt:hover{ border-color:var(--accent); }
.hub-lookup-apply{ margin-left:auto; font-size:12px; color:var(--accent); font-weight:700; }
.hub-lookup-note{ font-size:11px; color:var(--muted); margin:0; }
.hub-root.dark .hub-lookup-opt{ background:#111922; }
.hub-di{ border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-family:var(--sans);
  font-size:13px; color:var(--text); background:#fff; min-width:0; }
.hub-di:focus{ outline:2px solid var(--accent); outline-offset:0; border-color:var(--accent); }
.hub-di.title{ font-weight:600; font-size:14px; }
.hub-di-row{ display:flex; gap:8px; flex-wrap:wrap; }
.hub-di-row .hub-di{ flex:1 1 90px; }
.hub-di.grow{ flex:1 1 140px; }
.hub-di-travel{ display:flex; align-items:center; gap:5px; font-size:12px; color:var(--muted); }
.hub-di-travel .hub-di{ width:64px; }
.hub-draft-foot{ display:flex; align-items:center; justify-content:space-between; }

/* ---- ショートカット ---- */
.hub-sc-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.hub-sc-grid{ display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
.hub-sc-tile{ position:relative; }
.hub-sc-link{ display:flex; flex-direction:column; align-items:center; gap:8px; text-decoration:none;
  color:var(--text); padding:8px 4px; border-radius:11px; }
.hub-sc-link:hover{ background:#efe9dc; }
.hub-sc-icon{ width:52px; height:52px; border-radius:15px; display:flex; align-items:center; justify-content:center;
  color:#fff; font-family:var(--mono); font-size:22px; font-weight:700; box-shadow:0 4px 10px rgba(20,28,42,.16); }
.hub-sc-name{ font-size:12px; text-align:center; line-height:1.3; word-break:break-word; }
.hub-sc-del{ position:absolute; top:-4px; right:2px; z-index:2; width:20px; height:20px; border-radius:50%;
  border:0; background:#efe9dc; color:var(--muted); cursor:pointer; display:none; align-items:center; justify-content:center; }
.hub-sc-tile:hover .hub-sc-del{ display:flex; }
.hub-sc-del:hover{ background:var(--rush); color:#fff; }
.hub-swatches{ display:flex; gap:8px; }
.hub-swatch{ width:26px; height:26px; border-radius:7px; border:2px solid transparent; cursor:pointer; }
.hub-swatch.on{ border-color:var(--text); }

/* ---- モバイル端末フレーム ---- */
.hub-phonewrap{ display:flex; justify-content:center; padding:26px 16px 40px; }
/* 実機（スマホ）では枠を外して全画面に広げる */
.hub-phonewrap.bare{ padding:0; display:block; }
.hub-phone.bare{ max-width:none; width:100%; height:auto; min-height:100vh; min-height:100dvh;
  border:0; border-radius:0; box-shadow:none; }
.hub-phone.bare .hub-phonescroll{ overflow:visible; }
.hub-phone.bare .hub-phonebar{ position:sticky; top:0; z-index:15; }
.hub-phone.bare .hub-tabbar{ position:sticky; bottom:0; z-index:15;
  padding-bottom:env(safe-area-inset-bottom, 0px); }
.hub-phone.bare .hub-toasts{ top:60px; }
.hub-phone{ width:100%; max-width:400px; height:760px; max-height:82vh; background:var(--paper);
  border:10px solid var(--ink); border-radius:38px; box-shadow:0 24px 60px rgba(20,28,42,.3);
  overflow:hidden; display:flex; flex-direction:column; position:relative; }
.hub-phonescroll{ flex:1 1 auto; overflow-y:auto; overscroll-behavior:contain; }
.hub-phonebar{ flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:8px;
  background:var(--ink); color:#EDE7DA; padding:11px 14px; border-bottom:1px solid #0d141e; }
.hub-phonebar .hub-logo{ font-size:16px; }
.hub-pb-brand{ display:flex; align-items:baseline; gap:10px; min-width:0; }
.hub-pb-clock{ font-family:var(--mono); font-size:14px; letter-spacing:.1em; color:#EBD9A8;
  font-variant-numeric:tabular-nums; }
.hub-pb-ctl{ display:flex; align-items:center; gap:6px; }
.hub-pb-pc{ display:inline-flex; align-items:center; gap:4px; background:#0f1621; color:#c3ccd8;
  border:1px solid #2a3648; border-radius:999px; padding:5px 10px; font-family:var(--sans); font-size:12px;
  font-weight:600; cursor:pointer; }
.hub-pb-pc:hover{ border-color:var(--accent); color:#EDE7DA; }
.hub-phone .hub-gate{ margin:16px 14px; }
.hub-phone .hub-card{ margin:0 14px 16px; }
.hub-phone .hub-gate-right{ align-items:flex-start; text-align:left; }
.hub-phone .hub-gate-body{ gap:14px; }
.hub-phone .hub-board-t{ font-size:34px; }
.hub-phone .hub-sc-grid{ grid-template-columns:repeat(4,1fr); gap:10px; }
.hub-tabbar{ flex:0 0 auto; display:flex; background:var(--ink); border-top:1px solid #0d141e; }
.hub-tab{ flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; padding:11px 0 13px;
  background:transparent; border:0; color:#7d8ba0; font-family:var(--sans); font-size:11px; cursor:pointer; }
.hub-tab.on{ color:#EBD9A8; }
.hub-tab.on svg{ stroke:#EBD9A8; }

/* ---- リマインド：ツールバーのトグル ---- */
.hub-remindctl{ display:flex; gap:4px; background:#0f1621; border-radius:999px; padding:3px; }
.hub-rbtn{ display:flex; align-items:center; justify-content:center; width:34px; height:30px; border:0;
  background:transparent; color:#9aa6b6; border-radius:999px; cursor:pointer; transition:.15s; }
.hub-rbtn.on{ background:#EBD9A8; color:var(--ink); }
.hub-rbtn:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; }

/* ---- リマインド：トースト ---- */
.hub-toasts{ position:fixed; top:74px; right:18px; z-index:60; display:flex; flex-direction:column; gap:10px;
  width:min(340px, calc(100vw - 32px)); }
.hub-toast{ display:flex; align-items:flex-start; gap:10px; background:var(--ink); color:#EDE7DA;
  border:1px solid #0d141e; border-left:4px solid var(--soon); border-radius:11px; padding:12px 12px 12px 14px;
  box-shadow:0 14px 34px rgba(20,28,42,.34); animation:hubtoast .28s cubic-bezier(.2,.9,.3,1); }
.hub-toast.lv-rush{ border-left-color:var(--rush); }
.hub-toast.lv-soon{ border-left-color:var(--soon); }
.hub-toast .hub-signal{ margin-top:5px; }
.hub-toast-body{ flex:1 1 auto; min-width:0; }
.hub-toast-title{ font-size:14px; font-weight:700; color:#F5F0E4; }
.hub-toast-msg{ font-size:12.5px; color:#c3ccd8; margin-top:2px; line-height:1.5; }
.hub-toast-x{ background:transparent; border:0; color:#7d8ba0; cursor:pointer; padding:2px; border-radius:6px; }
.hub-toast-x:hover{ color:#EDE7DA; background:#0f1621; }
@keyframes hubtoast{ from{ transform:translateX(16px); opacity:0; } to{ transform:none; opacity:1; } }
@media (prefers-reduced-motion: reduce){ .hub-toast{ animation:none; } }

/* ---- リマインド：予定行のツール ---- */
.hub-ev-tools{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:8px; }
.hub-ev-transit{ margin-top:0; }
.hub-ev-remind{ display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--muted); }
.hub-ev-remind select{ border:1px solid var(--line); border-radius:7px; padding:3px 6px; font-size:12px;
  font-family:var(--sans); color:var(--text); background:#fff; cursor:pointer; }
.hub-ev-remind select:focus{ outline:2px solid var(--accent); }
.hub-ev-ics{ display:inline-flex; align-items:center; gap:5px; font-size:12px; color:var(--go); background:transparent;
  border:1px solid var(--line); border-radius:7px; padding:4px 9px; cursor:pointer; font-family:var(--sans); }
.hub-ev-ics:hover{ border-color:var(--go); background:#eef4f0; }

/* ---- リマインド：手入力フォーム ---- */
.hub-di-remind{ display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); }
.hub-di-remind select{ flex:1; cursor:pointer; }

/* ---- 繰り返し ---- */
.hub-di-repeat{ display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); }
.hub-di-repeat select{ flex:1; cursor:pointer; }
.hub-ev-repeat{ display:inline-flex; align-items:center; gap:3px; font-size:11px; font-weight:600;
  color:var(--accent); background:#eaf0f6; border-radius:999px; padding:1px 8px; margin-left:8px;
  vertical-align:middle; }

/* ---- 取り込み（.ics）一括バー ---- */
.hub-bulkbar{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;
  background:var(--ink); color:#EDE7DA; border-radius:11px; padding:10px 13px; margin-bottom:12px; font-size:13px; font-weight:600; }
.hub-bulk-actions{ display:flex; align-items:center; gap:8px; }
.hub-bulkbar .hub-ghostbtn{ color:#c3ccd8; border-color:#34425a; }
.hub-bulkbar .hub-ghostbtn:hover{ border-color:#5f6f84; }

/* ---- よく使う予定（テンプレート） ---- */
.hub-tpl{ background:#f4efe4; border:1px solid var(--line); border-radius:11px; padding:11px 12px; margin-top:14px; }
.hub-tpl-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.hub-tpl-eyebrow{ display:inline-flex; align-items:center; gap:5px; font-family:var(--mono); font-size:10px;
  letter-spacing:.18em; text-transform:uppercase; color:var(--muted); }
.hub-tpl-manage{ background:transparent; border:0; color:var(--accent); font-size:12px; font-weight:600; cursor:pointer; }
.hub-tpl-empty{ font-size:12px; color:var(--muted); line-height:1.6; margin:0; }
.hub-tpl-chips{ display:flex; flex-wrap:wrap; gap:8px; }
.hub-chip{ display:inline-flex; align-items:stretch; background:#fff; border:1px solid var(--line);
  border-radius:999px; overflow:hidden; }
.hub-chip-add{ display:inline-flex; align-items:center; gap:5px; background:transparent; border:0;
  padding:6px 12px; cursor:pointer; font-family:var(--sans); color:var(--text); font-size:12.5px; }
.hub-chip-add:hover{ background:#efe9dc; }
.hub-chip-title{ font-weight:600; }
.hub-chip-time{ font-family:var(--mono); color:var(--muted); font-size:11.5px; }
.hub-chip-del{ display:flex; align-items:center; justify-content:center; width:26px; border:0; border-left:1px solid var(--line);
  background:#f8ebe8; color:var(--rush); cursor:pointer; }
.hub-chip-del:hover{ background:var(--rush); color:#fff; }
.hub-tpl-check{ display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); cursor:pointer; }
.hub-tpl-check input{ width:15px; height:15px; accent-color:var(--go); }

/* ---- 予定行：右側アクション ---- */
.hub-ev-side{ display:flex; flex-direction:column; gap:2px; flex:0 0 auto; }
.hub-ev-confirm{ display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
.hub-ev-confirm > span{ font-size:11px; color:var(--muted); }
.hub-ev-cf{ border:1px solid var(--line); background:transparent; color:var(--text); border-radius:7px;
  padding:4px 10px; font-size:12px; font-family:var(--sans); cursor:pointer; }
.hub-ev-cf:hover{ border-color:var(--muted); }
.hub-ev-cf.yes{ background:var(--rush); border-color:var(--rush); color:#fff; font-weight:600; }
.hub-ev-cf.yes:hover{ filter:brightness(1.05); }

/* ---- カレンダー：一括保存 ---- */
.hub-cal-foot{ margin-top:14px; padding-top:14px; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:8px; }
.hub-ghostbtn.wide{ width:100%; justify-content:center; }
.hub-ghostbtn:disabled,.hub-primary:disabled{ opacity:.45; cursor:not-allowed; }
.hub-cal-note{ font-size:11px; color:var(--muted); margin:2px 2px 0; line-height:1.6; }

/* ---- ポータル内・乗換案内モーダル ---- */
.hub-modal-backdrop{ position:fixed; inset:0; z-index:70; background:rgba(17,23,34,.5);
  backdrop-filter:blur(2px); display:flex; align-items:center; justify-content:center; padding:20px;
  animation:hubfade .18s ease; }
@keyframes hubfade{ from{ opacity:0; } to{ opacity:1; } }
.hub-modal{ width:min(460px,100%); max-height:88vh; overflow-y:auto; background:var(--card);
  border:1px solid var(--line); border-radius:16px; padding:18px; box-shadow:0 24px 60px rgba(17,23,34,.4);
  animation:hubpop .22s cubic-bezier(.2,.9,.3,1); }
@keyframes hubpop{ from{ transform:translateY(10px) scale(.98); opacity:0; } to{ transform:none; opacity:1; } }
@media (prefers-reduced-motion: reduce){ .hub-modal,.hub-modal-backdrop{ animation:none; } }
.hub-modal-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.hub-modal-close{ background:transparent; border:0; color:var(--muted); cursor:pointer; padding:4px; border-radius:8px; }
.hub-modal-close:hover{ background:#efe9dc; color:var(--text); }
.hub-route-od{ display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
.hub-od-chip{ display:inline-flex; align-items:center; gap:5px; background:#efe9dc; border:1px solid var(--line);
  padding:6px 11px; border-radius:9px; font-size:13px; font-weight:600; }
.hub-od-chip.dest{ background:var(--ink); color:#EDE7DA; border-color:#0d141e; }
.hub-route-for{ font-size:13px; color:var(--muted); margin:8px 2px 4px; }

.hub-timeline{ margin:14px 0; }
.hub-tl-row{ display:grid; grid-template-columns:52px 22px 1fr; align-items:center; min-height:38px; }
.hub-tl-row.mid{ min-height:30px; }
.hub-tl-time{ font-family:var(--mono); font-size:15px; font-weight:700; text-align:right; padding-right:8px;
  font-variant-numeric:tabular-nums; }
.hub-tl-rail{ position:relative; height:100%; display:flex; justify-content:center; }
.hub-tl-rail::before{ content:""; position:absolute; top:0; bottom:0; width:2px; background:var(--line); }
.hub-tl-row:first-child .hub-tl-rail::before{ top:50%; }
.hub-tl-row:last-child .hub-tl-rail::before{ bottom:50%; }
.hub-tl-node{ position:relative; width:11px; height:11px; border-radius:50%; background:var(--card);
  border:2px solid var(--muted); align-self:center; z-index:1; }
.hub-tl-node.n-start{ border-color:var(--go); background:var(--go); }
.hub-tl-node.n-end{ border-color:var(--accent); background:var(--accent); }
.hub-tl-row.mid .hub-tl-node{ width:7px; height:7px; border-width:0; background:var(--line); }
.hub-tl-body{ padding:5px 0 5px 10px; }
.hub-tl-label{ font-size:14px; font-weight:600; }
.hub-tl-row.mid .hub-tl-label{ font-size:12.5px; font-weight:500; color:var(--muted); }
.hub-tl-sub{ font-size:11.5px; color:var(--muted); margin-top:1px; }

.hub-travel-edit{ background:#f4efe4; border:1px solid var(--line); border-radius:11px; padding:11px 13px; margin:6px 0 14px; }
.hub-te-label{ font-size:12px; color:var(--muted); font-weight:600; }
.hub-te-ctl{ display:flex; align-items:center; gap:8px; margin-top:8px; }
.hub-te-ctl .hub-iconbtn{ border:1px solid var(--line); width:32px; height:32px; font-size:18px; background:#fff; }
.hub-te-val{ font-family:var(--mono); font-size:20px; font-weight:700; min-width:56px; text-align:center; }
.hub-te-val small{ font-size:11px; color:var(--muted); margin-left:1px; }
.hub-te-ctl .hub-ghostbtn{ margin-left:auto; }

.hub-ai-route{ margin-top:12px; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.hub-ai-summary{ display:flex; align-items:center; gap:12px; background:#f4efe4; padding:9px 13px;
  font-size:13px; font-weight:700; border-bottom:1px solid var(--line); }
.hub-apply-mini{ margin-left:auto; font-size:12px; font-weight:600; color:var(--accent); background:transparent;
  border:1px solid var(--line); border-radius:7px; padding:4px 9px; cursor:pointer; }
.hub-apply-mini:hover{ border-color:var(--accent); }
.hub-legs{ list-style:none; margin:0; padding:6px 13px; display:flex; flex-direction:column; }
.hub-leg{ display:flex; align-items:center; gap:11px; padding:8px 0; border-bottom:1px dashed var(--line); }
.hub-leg:last-child{ border-bottom:0; }
.hub-leg-ic{ flex:0 0 auto; width:34px; height:26px; display:flex; align-items:center; justify-content:center;
  background:var(--ink); color:#EDE7DA; border-radius:7px; font-size:11px; }
.hub-leg.walk .hub-leg-ic{ background:#e0d8c7; color:var(--text); }
.hub-leg.bus .hub-leg-ic{ background:#2f7d5b; color:#fff; }
.hub-leg-main{ flex:1 1 auto; min-width:0; }
.hub-leg-line{ display:block; font-size:13px; font-weight:600; }
.hub-leg-od{ display:block; font-size:11.5px; color:var(--muted); }
.hub-leg-mins{ font-family:var(--mono); font-size:13px; font-weight:700; }
.hub-ai-memo{ font-size:12px; color:var(--text); padding:0 13px 8px; }
.hub-ai-note{ font-size:11px; color:var(--muted); background:#f4efe4; padding:9px 13px; line-height:1.6; }
.hub-modal-ext{ font-size:11.5px; color:var(--muted); margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
.hub-modal-ext a{ color:var(--accent); text-decoration:none; margin-left:10px; }
.hub-modal-ext a:hover{ text-decoration:underline; }

.hub-phone .hub-toasts{ position:absolute; top:56px; right:12px; left:12px; width:auto; }

@media (max-width: 560px){
  .hub-bar{ padding:12px 14px; gap:8px; }
  .hub-clock{ font-size:16px; }
  .hub-modebtn span{ display:none; }
  .hub-modebtn{ padding:7px 10px; }
  .hub-gate{ margin:16px 14px; padding:16px; }
  .hub-grid{ padding:0 14px; }
  .hub-board-t{ font-size:34px; }
  .hub-toasts{ top:64px; right:12px; left:12px; width:auto; }
}
`;
