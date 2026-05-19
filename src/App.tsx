import { useState, useCallback, useRef, useEffect, type DragEvent, type ChangeEvent } from "react";
import { cn } from "@/utils/cn";

// ---------- Types ----------

interface SrtSegment {
  index: number;
  start: string;
  end: string;
  text: string;
}

type Status = "idle" | "transcribing" | "translating" | "done" | "error";
type FileKind = "media" | "srt" | "none";

// ---------- Helpers ----------

function parseSrt(raw: string): SrtSegment[] {
  const segments: SrtSegment[] = [];
  const blocks = raw.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;
    const idx = parseInt(lines[0], 10);
    if (isNaN(idx)) continue;
    const timeMatch = lines[1].match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!timeMatch) continue;
    segments.push({
      index: idx,
      start: timeMatch[1].replace(".", ","),
      end: timeMatch[2].replace(".", ","),
      text: lines.slice(2).join("\n").trim(),
    });
  }
  return segments;
}

function segmentsToSrt(segments: SrtSegment[]): string {
  return segments.map((seg) => `${seg.index}\n${seg.start} --> ${seg.end}\n${seg.text}\n`).join("\n");
}

function secsToTimestamp(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function chunkSegments(segs: SrtSegment[], perChunk: number): SrtSegment[][] {
  const chunks: SrtSegment[][] = [];
  for (let i = 0; i < segs.length; i += perChunk) chunks.push(segs.slice(i, i + perChunk));
  return chunks;
}

const LANGUAGES = [
  { code: "my", name: "မြန်မာ (Myanmar / Burmese)" },
  { code: "en", name: "English" },
  { code: "zh", name: "中文 (Chinese)" },
  { code: "ja", name: "日本語 (Japanese)" },
  { code: "ko", name: "한국어 (Korean)" },
  { code: "th", name: "ไทย (Thai)" },
  { code: "vi", name: "Tiếng Việt (Vietnamese)" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "hi", name: "हिन्दी (Hindi)" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "es", name: "Español" },
  { code: "pt", name: "Português" },
  { code: "ru", name: "Русский" },
  { code: "ar", name: "العربية (Arabic)" },
];

const GROQ_WHISPER_MODELS = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo (Fast)" },
  { id: "whisper-large-v3", label: "Whisper Large v3 (Accurate)" },
];

const GEMINI_TRANSLATE_MODELS = [
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview (Recommended)" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite (Higher quota)" },
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Parse raw input into clean key array: supports comma, newline, or space separation */
function parseKeys(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map(k => k.trim())
    .filter(k => k.length > 0 && (k.startsWith("AIza") || k.startsWith("gsk_")));
}

// ── Key rotation helper ──
class KeyRotator {
  keys: string[];
  index: number;
  constructor(keys: string[]) { this.keys = keys; this.index = 0; }
  current(): string { return this.keys[this.index] || ""; }
  /** Rotate to next key. Returns true if there is another key available. */
  next(): boolean {
    if (this.index < this.keys.length - 1) { this.index++; return true; }
    return false;
  }
  reset() { this.index = 0; }
  count() { return this.keys.length; }
  active() { return this.index + 1; } // 1-based for display
}

// ── Constants ──
const MAX_CHUNK_RETRIES = 3; // retries per chunk with different keys

// ---------- Component ----------

export default function App() {
  // Keys
  const [groqKey, setGroqKey] = useState(() => localStorage.getItem("groq_api_key") || "");
  const [geminiKeysRaw, setGeminiKeysRaw] = useState(() => localStorage.getItem("gemini_api_keys") || "");
  const [showGroqKey, setShowGroqKey] = useState(false);
  const [showGeminiKeys, setShowGeminiKeys] = useState(false);
  const [totalGeminiKeys, setTotalGeminiKeys] = useState(() => parseKeys(localStorage.getItem("gemini_api_keys") || "").length);

  // Models
  const [groqSttModel, setGroqSttModel] = useState("whisper-large-v3-turbo");
  const [geminiModel, setGeminiModel] = useState("gemini-3-flash-preview");

  // File & status
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<FileKind>("none");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [segments, setSegments] = useState<SrtSegment[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [translateTarget, setTranslateTarget] = useState("my");
  const [dragOver, setDragOver] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editText, setEditText] = useState("");
  const [chunkSize, setChunkSize] = useState(50);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist
  useEffect(() => { localStorage.setItem("groq_api_key", groqKey); }, [groqKey]);
  useEffect(() => {
    localStorage.setItem("gemini_api_keys", geminiKeysRaw);
    setTotalGeminiKeys(parseKeys(geminiKeysRaw).length);
  }, [geminiKeysRaw]);

  const geminiKeys = parseKeys(geminiKeysRaw);

  const readFileAsText = (f: File) => new Promise<string>((resolve, reject) => {
    const r = new FileReader(); r.onload = () => resolve(r.result as string); r.onerror = reject; r.readAsText(f);
  });

  // ── File handler ──
  const handleFile = useCallback(async (f: File | null) => {
    if (!f) return;
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (ext === "srt") {
      try {
        const text = await readFileAsText(f);
        const parsed = parseSrt(text);
        if (parsed.length === 0) { setErrorMsg("Invalid SRT format."); setStatus("error"); return; }
        setFile(f); setFileKind("srt"); setSegments(parsed); setStatus("done"); setErrorMsg(""); setProgress(100);
      } catch { setErrorMsg("Failed to read SRT file."); setStatus("error"); }
      return;
    }
    const ok = ["mp3","wav","ogg","flac","aac","m4a","wma","opus","webm","mp4","mov","avi","mkv","flv","wmv"];
    if (ext && ok.includes(ext)) {
      if (f.size > 500 * 1024 * 1024) { setErrorMsg("Max 500MB."); setStatus("error"); return; }
      if (f.size > 25 * 1024 * 1024) { setErrorMsg("Groq Whisper max 25MB. Use a shorter file or compress."); setStatus("error"); return; }
      setFile(f); setFileKind("media"); setStatus("idle"); setSegments([]); setErrorMsg(""); setProgress(0);
      return;
    }
    setErrorMsg(`Unsupported file: .${ext || "?"}`); setStatus("error");
  }, []);

  const onDrop = useCallback((e: DragEvent) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0] || null); }, [handleFile]);
  const onDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => handleFile(e.target.files?.[0] || null);

  // ── TRANSCRIBE: Groq Whisper ──
  const transcribe = useCallback(async () => {
    if (!file || !groqKey.trim()) return;
    setStatus("transcribing"); setProgress(10); setProgressMsg("Uploading to Groq Whisper..."); setErrorMsg("");
    try {
      setProgress(25);
      const form = new FormData();
      form.append("file", file);
      form.append("model", groqSttModel);
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");

      const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${groqKey.trim()}` }, body: form,
      });
      setProgress(70); setProgressMsg("Processing...");
      if (!res.ok) { const eb = await res.json().catch(() => ({})); throw new Error((eb as any)?.error?.message || `Groq error ${res.status}`); }
      const data = await res.json();
      const raw = data?.segments;
      if (!raw || !Array.isArray(raw) || raw.length === 0) throw new Error("No transcription. Audio may be silent.");
      const parsed: SrtSegment[] = raw.map((seg: any, i: number) => ({
        index: i + 1, start: secsToTimestamp(seg.start), end: secsToTimestamp(seg.end), text: (seg.text || "").trim(),
      })).filter((s: SrtSegment) => s.text.length > 0);
      if (parsed.length === 0) throw new Error("Empty transcription.");
      setSegments(parsed); setStatus("done"); setProgress(100); setProgressMsg("");
    } catch (err: any) {
      const m = (err?.message || String(err)).toLowerCase();
      if (m.includes("401") || m.includes("key")) setErrorMsg("Invalid Groq API key.");
      else if (m.includes("429") || m.includes("rate")) setErrorMsg("Groq rate limit. Wait 1 min.");
      else if (m.includes("413") || m.includes("large")) setErrorMsg("Audio too large (25MB max).");
      else setErrorMsg(err?.message || "Transcription failed.");
      setStatus("error"); setProgress(0); setProgressMsg("");
    }
  }, [file, groqKey, groqSttModel]);

  // ── Single Gemini call helper ──
  const callGemini = useCallback(async (prompt: string, key: string): Promise<string> => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
        }),
      }
    );
    if (!res.ok) {
      const eb = await res.json().catch(() => ({}));
      const e = (eb as any)?.error;
      throw { message: e?.message || `Gemini ${res.status}`, status: res.status, code: e?.status };
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }, [geminiModel]);

  // ── TRANSLATE: Gemini with multi-key rotation ──
  const translate = useCallback(async () => {
    if (segments.length === 0 || geminiKeys.length === 0) return;
    const tgt = LANGUAGES.find(l => l.code === translateTarget)?.name || translateTarget;
    setStatus("translating"); setProgress(0); setProgressMsg(""); setErrorMsg("");

    const rotator = new KeyRotator(geminiKeys);

    try {
      const chunks = chunkSegments(segments, chunkSize);
      const totalChunks = chunks.length;
      const allResults: SrtSegment[] = [];

      for (let ci = 0; ci < totalChunks; ci++) {
        const chunk = chunks[ci];
        const chunkSrt = segmentsToSrt(chunk);
        const pct = Math.round((ci / totalChunks) * 100);
        setProgress(pct);
        setProgressMsg(`Chunk ${ci + 1}/${totalChunks} (${chunk.length} seg) • Key #${rotator.active()}/${rotator.count()}`);

        const prompt = `Translate ONLY the subtitle TEXT into **${tgt}**.
RULES:
- Keep ALL timestamps (HH:MM:SS,mmm) unchanged
- Keep ALL index numbers unchanged
- Keep " --> " separator unchanged
- Translate ONLY the text content after each timestamp line
- Output the COMPLETE SRT block with same structure
- Natural, fluent translation in ${tgt}
- Output ONLY the SRT — no markdown, no explanations

SRT to translate:

${chunkSrt}`;

        // Try with key rotation
        let translated = "";
        let lastErr: any;

        for (let attempt = 0; attempt < Math.min(rotator.count(), MAX_CHUNK_RETRIES); attempt++) {
          try {
            translated = await callGemini(prompt, rotator.current());
            break; // success
          } catch (err: any) {
            lastErr = err;
            const msg = (err?.message || "").toLowerCase();
            // If rate-limited or quota exceeded → rotate key
            if (msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted") || msg.includes("rate")) {
                if (rotator.next()) {
                setProgressMsg(`Chunk ${ci + 1}/${totalChunks} • Rate-limited → switched to Key #${rotator.active()}/${rotator.count()}`);
                continue;
              }
              throw new Error(`All ${rotator.count()} keys rate-limited. Wait 1 minute and try again.`);
            }
            // Geo-block / auth / other errors → don't retry
            throw err;
          }
        }

        if (!translated && lastErr) throw lastErr;
        if (!translated.trim()) throw new Error(`Chunk ${ci + 1}: no translation returned.`);

        const parsed = parseSrt(translated);
        if (parsed.length === 0) throw new Error(`Chunk ${ci + 1}: could not parse. Model output unexpected format.`);

        allResults.push(...parsed);
      }

      const reindexed = allResults.map((s, i) => ({ ...s, index: i + 1 }));
      setSegments(reindexed);
      setStatus("done"); setProgress(100);
      setProgressMsg(`✓ ${reindexed.length} segments translated`);
    } catch (err: any) {
      const m = (err?.message || String(err)).toLowerCase();
      if (m.includes("location") || m.includes("not supported"))
        setErrorMsg("Gemini API blocked in your region.");
      else if (m.includes("api key") || m.includes("403") || m.includes("401"))
        setErrorMsg("One or more Gemini keys are invalid.");
      else if (m.includes("all") && m.includes("rate-limited"))
        setErrorMsg(`All ${geminiKeys.length} keys rate-limited. Wait 1 minute.`);
      else if (m.includes("429") || m.includes("quota") || m.includes("exhausted"))
        setErrorMsg("Current key rate-limited. Auto-rotating to next key...");
      else setErrorMsg(err?.message || "Translation failed.");
      setStatus("error"); setProgress(0); setProgressMsg("");
    }
  }, [segments, geminiKeys, geminiModel, translateTarget, chunkSize, callGemini]);

  // ── Edit / Download / Reset ──
  const startEdit = () => { setEditText(segmentsToSrt(segments)); setEditMode(true); };
  const saveEdit = () => {
    const p = parseSrt(editText);
    if (p.length === 0) { alert("Invalid SRT format."); return; }
    setSegments(p); setEditMode(false);
  };
  const download = () => {
    const blob = new Blob([segmentsToSrt(segments)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${file?.name?.replace(/\.[^.]+$/, "") || "subtitles"}.srt`;
    a.click();
  };
  const copyToClipboard = () => navigator.clipboard.writeText(segmentsToSrt(segments));
  const reset = () => {
    setFile(null); setFileKind("none"); setStatus("idle"); setSegments([]); setErrorMsg(""); setProgress(0); setProgressMsg(""); setEditMode(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Derived ──
  const isMedia = fileKind === "media";
  const isSrt = fileKind === "srt";
  const hasSegs = segments.length > 0;
  const isBusy = status === "transcribing" || status === "translating";
  const canTranscribe = !!file && isMedia && !!groqKey.trim() && !isBusy;
  const canTranslate = hasSegs && geminiKeys.length > 0 && !isBusy;
  const estTokens = hasSegs ? estimateTokens(segmentsToSrt(segments)) : 0;
  const totalDur = hasSegs ? (() => {
    const [h, m, s] = segments[segments.length - 1].end.split(":").map(Number);
    const ts = h * 3600 + m * 60 + s;
    return `${Math.floor(ts / 3600) > 0 ? Math.floor(ts / 3600) + "h " : ""}${Math.floor((ts % 3600) / 60)}m ${Math.floor(ts % 60)}s`;
  })() : "0s";
  const statusLabel = status === "idle" ? "Ready" : status === "transcribing" ? "Transcribing..." : status === "translating" ? "Translating..." : status === "done" ? (isSrt ? "Loaded" : "Complete") : "Error";

  // ============ RENDER ============
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">SRT Generator</h1>
              <p className="text-xs text-zinc-500">Groq Whisper • Gemini Translate • Multi-Key</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("w-2 h-2 rounded-full",
              status === "idle" && "bg-zinc-600",
              status === "transcribing" && "bg-orange-500 animate-pulse",
              status === "translating" && "bg-blue-500 animate-pulse",
              status === "done" && "bg-emerald-500",
              status === "error" && "bg-red-500"
            )} />
            <span className="text-xs text-zinc-500 uppercase tracking-widest">{statusLabel}</span>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">

        {/* ═══ API KEYS ═══ */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">🔑 API Keys</h2>
          <p className="text-xs text-zinc-500 -mt-2">All free — no credit card required.</p>

          {/* Groq */}
          <div className="bg-zinc-950 border border-orange-500/20 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-orange-400" />
              <h3 className="text-sm font-bold text-orange-400">Groq API Key</h3>
              <span className="text-[10px] text-orange-400/60 font-mono">→ Speech-to-Text (Whisper)</span>
            </div>
            <div className="relative">
              <input type={showGroqKey ? "text" : "password"} value={groqKey} onChange={e => setGroqKey(e.target.value)} placeholder="gsk_..." className="w-full bg-zinc-900 border border-orange-500/20 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-orange-500/50 pr-10" />
              <button onClick={() => setShowGroqKey(!showGroqKey)} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs">{showGroqKey ? "🙈" : "👁"}</button>
            </div>
            <p className="text-[10px] text-zinc-500"><a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">Get free key →</a></p>
          </div>

          {/* Gemini — Multi-key */}
          <div className="bg-zinc-950 border border-blue-500/20 rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <h3 className="text-sm font-bold text-blue-400">Gemini API Keys</h3>
              <span className="text-[10px] text-blue-400/60 font-mono">→ Translation (Text-out)</span>
              {totalGeminiKeys > 0 && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-bold">
                  {totalGeminiKeys} key{totalGeminiKeys > 1 ? "s" : ""} loaded
                </span>
              )}
            </div>
            <div className="relative">
              <textarea
                rows={3}
                value={showGeminiKeys ? geminiKeysRaw : geminiKeysRaw.replace(/AIza[A-Za-z0-9_-]{20,}/g, "***")}
                onChange={e => setGeminiKeysRaw(e.target.value)}
                placeholder={`Paste Gemini keys here — one per line, or comma separated:\nAIzaSyExampleKey1\nAIzaSyExampleKey2`}
                spellCheck={false}
                className="w-full bg-zinc-900 border border-blue-500/20 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500/50 resize-y font-mono"
              />
              <button onClick={() => setShowGeminiKeys(!showGeminiKeys)} className="absolute right-3 top-3 text-zinc-500 hover:text-zinc-300 text-xs">{showGeminiKeys ? "🙈 Hide" : "👁 Show"}</button>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-zinc-500"><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Get free keys →</a> — Paste multiple keys, one per line</p>
              {geminiKeys.length > 1 && (
                <p className="text-[10px] text-emerald-400/80">🔄 Auto-rotates on rate limit</p>
              )}
            </div>
          </div>
        </section>

        {/* ═══ MODELS ═══ */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">⚙️ Models & Settings</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-medium">🟠 Groq Whisper (STT)</label>
              <select value={groqSttModel} onChange={e => setGroqSttModel(e.target.value)} className="w-full bg-zinc-950 border border-orange-500/20 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-orange-500/50">
                {GROQ_WHISPER_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <p className="text-[9px] text-zinc-600 mt-0.5">Auto-detects language</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-medium">🔵 Gemini Model (Translate)</label>
              <select value={geminiModel} onChange={e => setGeminiModel(e.target.value)} className="w-full bg-zinc-950 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-blue-500/50">
                {GEMINI_TRANSLATE_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <p className="text-[9px] text-zinc-600 mt-0.5">Gemini 3 Flash = best translation quality</p>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1 font-medium">Chunk Size</label>
              <select value={chunkSize} onChange={e => setChunkSize(Number(e.target.value))} className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-zinc-500">
                {[25, 50, 75, 100, 200].map(n => <option key={n} value={n}>{n} segments</option>)}
              </select>
              <p className="text-[9px] text-zinc-600 mt-0.5">Smaller = safer, more chunks</p>
            </div>
          </div>
          {geminiKeys.length > 1 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
              <span className="text-emerald-400 text-xs">🔄</span>
              <p className="text-[10px] text-emerald-300">
                <strong>Multi-key rotation active!</strong> With {geminiKeys.length} keys at 20 RPD each, you have ~{geminiKeys.length * 20} requests/day total. If one key hits its limit, the next one auto rotates.
              </p>
            </div>
          )}
        </section>

        {/* ═══ FILE UPLOAD ═══ */}
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">📁 Upload File</h2>
          <div onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave} onClick={() => fileInputRef.current?.click()}
            className={cn("relative border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all",
              dragOver ? "border-emerald-400 bg-emerald-500/10" : file ? (isSrt ? "border-violet-500/30 bg-violet-500/5" : "border-orange-500/30 bg-orange-500/5") : "border-zinc-700 hover:border-zinc-500 bg-zinc-950/50")}>
            <input ref={fileInputRef} type="file" accept="audio/*,video/*,.srt" onChange={onFileChange} className="hidden" />
            {file ? (
              <div className="space-y-2">
                <div className={cn("w-14 h-14 mx-auto rounded-xl flex items-center justify-center", isSrt ? "bg-violet-500/10" : "bg-orange-500/10")}>
                  {isSrt ? <svg className="w-7 h-7 text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
                   : <svg className="w-7 h-7 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>}
                </div>
                <p className="text-sm font-medium text-zinc-200">{file.name}</p>
                <p className="text-xs text-zinc-500">{isSrt ? `SRT • ${segments.length} segments` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}</p>
                {isSrt && <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/20"><span className="w-1.5 h-1.5 rounded-full bg-violet-400" /><span className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider">View, Edit & Translate</span></span>}
                <button onClick={(e) => { e.stopPropagation(); reset(); }} className="block mx-auto text-xs text-zinc-500 hover:text-red-400 underline mt-1">Remove</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="w-14 h-14 mx-auto rounded-xl bg-zinc-800 flex items-center justify-center">
                  <svg className="w-7 h-7 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                </div>
                <p className="text-sm font-medium text-zinc-300">Drag & drop or click to upload</p>
                <p className="text-xs text-zinc-500">🎵 Audio: MP3, WAV, OGG, FLAC, AAC, M4A (max 25MB)</p>
                <p className="text-xs text-zinc-500">🎬 Video: MP4, MOV, AVI, MKV, WEBM (max 25MB)</p>
                <p className="text-xs text-violet-400/80 mt-1.5 font-medium">📝 .SRT files: view, edit & translate</p>
              </div>
            )}
          </div>
        </section>

        {/* ═══ TRANSCRIBE ═══ */}
        {isMedia && (
          <div className="flex justify-center">
            <button onClick={transcribe} disabled={!canTranscribe}
              className={cn("px-8 py-3 rounded-xl font-semibold text-sm transition-all flex items-center gap-2",
                canTranscribe ? "bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-500/25 active:scale-95" : "bg-zinc-800 text-zinc-500 cursor-not-allowed")}>
              {status === "transcribing" ? (<><svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" /></svg> Transcribing...</>) : (<>🎤 Generate SRT via Groq Whisper</>)}
            </button>
          </div>
        )}

        {/* ═══ TRANSLATE ═══ */}
        {hasSegs && (status === "done" || isSrt) && (
          <section className="bg-zinc-900 border border-blue-500/20 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-blue-400 mb-1">🌐 Translate via Gemini</h2>
              <p className="text-xs text-zinc-500">
                {segments.length} segments • ~{estTokens} est. tokens • {Math.ceil(segments.length / chunkSize)} chunk{Math.ceil(segments.length / chunkSize) > 1 ? "s" : ""}
                {geminiKeys.length > 1 && <span className="text-emerald-400 ml-1">• {geminiKeys.length} keys rotating</span>}
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="flex-1 w-full">
                <label className="block text-xs text-zinc-500 mb-1 font-medium">Translate to</label>
                <select value={translateTarget} onChange={e => setTranslateTarget(e.target.value)} className="w-full bg-zinc-950 border border-blue-500/30 rounded-lg px-3 py-2.5 text-sm text-zinc-100 focus:outline-none focus:border-blue-400/50">
                  {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
                </select>
              </div>
              <button onClick={translate} disabled={!canTranslate}
                className={cn("px-6 py-2.5 rounded-xl font-semibold text-sm transition-all flex items-center gap-2 shrink-0",
                  canTranslate ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/25 active:scale-95" : "bg-zinc-800 text-zinc-500 cursor-not-allowed")}>
                {status === "translating" ? (<><svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" /></svg> Translating...</>) : "🌐 Translate Now"}
              </button>
            </div>
            {geminiKeys.length === 0 && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <span className="text-amber-400 text-xs">⚠️</span>
                <p className="text-xs text-amber-300">Add at least one Gemini API key above. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="underline">Get free keys →</a></p>
              </div>
            )}
          </section>
        )}

        {/* ═══ PROGRESS ═══ */}
        {isBusy && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
            <div className="flex justify-between text-xs text-zinc-500">
              <span>{progressMsg || (status === "transcribing" ? "Transcribing..." : "Translating...")}</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
              <div className={cn("h-full rounded-full transition-all duration-300", status === "translating" ? "bg-gradient-to-r from-blue-500 to-cyan-400" : "bg-gradient-to-r from-orange-500 to-amber-400")} style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* ═══ ERROR ═══ */}
        {status === "error" && errorMsg && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-400 mt-0.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
            <div><p className="text-sm font-medium text-red-300">Error</p><p className="text-xs text-red-400/80 mt-1 whitespace-pre-wrap">{errorMsg}</p></div>
          </div>
        )}

        {/* ═══ RESULTS ═══ */}
        {hasSegs && (status === "done" || isSrt || isBusy) && (
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-zinc-800 flex flex-wrap items-center justify-between gap-3">
              <div><h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">📝 Subtitles</h2><p className="text-xs text-zinc-500 mt-0.5">{segments.length} segments • ~{totalDur}{isSrt && <span className="text-violet-400 ml-2">• {file?.name}</span>}</p></div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={startEdit} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800">✏️ Edit</button>
                <button onClick={copyToClipboard} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800">📋 Copy</button>
                <button onClick={download} className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">⬇ Download .SRT</button>
              </div>
            </div>
            {editMode && (
              <div className="p-4 border-b border-zinc-800 bg-zinc-950 space-y-3">
                <textarea value={editText} onChange={e => setEditText(e.target.value)} className="w-full h-64 bg-zinc-900 border border-zinc-700 rounded-lg p-4 text-xs font-mono text-zinc-200 focus:outline-none focus:border-emerald-500/50 resize-y" spellCheck={false} />
                <div className="flex gap-2"><button onClick={saveEdit} className="px-4 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white">✅ Save</button><button onClick={() => setEditMode(false)} className="px-4 py-2 text-xs font-medium rounded-lg border border-zinc-700 text-zinc-400 hover:bg-zinc-800">Cancel</button></div>
              </div>
            )}
            <div className="p-4 max-h-[500px] overflow-y-auto">
              <div className="space-y-1">
                {segments.map(seg => (
                  <div key={seg.index} className="flex gap-3 py-2 px-3 rounded-lg hover:bg-zinc-800/50 transition-colors">
                    <span className="text-xs text-zinc-600 font-mono pt-0.5 shrink-0 w-8 text-right">{seg.index}</span>
                    <div className="min-w-0"><span className="text-[10px] text-emerald-500/70 font-mono block">{seg.start} → {seg.end}</span><p className="text-sm text-zinc-200 mt-0.5 leading-relaxed">{seg.text}</p></div>
                  </div>
                ))}
              </div>
            </div>
            <details className="border-t border-zinc-800">
              <summary className="p-4 text-xs text-zinc-500 cursor-pointer hover:text-zinc-300 font-medium">View Raw SRT</summary>
              <pre className="p-4 bg-zinc-950 text-xs font-mono text-zinc-400 overflow-x-auto max-h-[300px] overflow-y-auto">{segmentsToSrt(segments)}</pre>
            </details>
          </section>
        )}
      </main>

      <footer className="border-t border-zinc-800 mt-12 py-6 text-center">
        <p className="text-xs text-zinc-600">Groq Whisper → STT &nbsp;|&nbsp; Gemini → Translate &nbsp;|&nbsp; Multi-key rotation &nbsp;|&nbsp; All browser-side</p>
      </footer>
    </div>
  );
}
