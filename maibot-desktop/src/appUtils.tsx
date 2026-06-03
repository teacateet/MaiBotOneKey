import type { CSSProperties, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  OFFLINE_ALERT_LOG_WINDOW,
  PROCESS_ORDER,
  SERVICE_IDS,
  STORAGE_KEY,
} from "./appConstants";
import type { ProcessSnapshot, ServiceEndpoint, ServiceId, VoiceChatConfig } from "./types";

const ANSI_ESCAPE_SEQUENCE_SOURCE = String.raw`\u001b\[[0-9;]*m`;
const ANSI_CONTROL_PATTERN = new RegExp(ANSI_ESCAPE_SEQUENCE_SOURCE, "g");
const ANSI_SPLIT_PATTERN = new RegExp(`(${ANSI_ESCAPE_SEQUENCE_SOURCE})`, "g");
const ANSI_FULL_TOKEN_PATTERN = new RegExp(`^${ANSI_ESCAPE_SEQUENCE_SOURCE}$`);

type AnsiState = {
  color?: string;
  backgroundColor?: string;
  fontWeight?: CSSProperties["fontWeight"];
  fontStyle?: CSSProperties["fontStyle"];
  textDecoration?: string;
  opacity?: number;
};

const BASIC_ANSI_COLORS = [
  "#111827",
  "#ef4444",
  "#22c55e",
  "#eab308",
  "#3b82f6",
  "#a855f7",
  "#06b6d4",
  "#e5e7eb",
];

const BRIGHT_ANSI_COLORS = [
  "#6b7280",
  "#f87171",
  "#4ade80",
  "#fde047",
  "#60a5fa",
  "#c084fc",
  "#22d3ee",
  "#ffffff",
];

export function isTauriEnvironment() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function openExternal(url: string) {
  try {
    await invoke("open_external_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function loadStoredUrls(): Partial<Record<ServiceId, string>> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return sanitizeStoredServiceUrls(parsed as Partial<Record<ServiceId, string>>);
  } catch {
    return {};
  }
}

export function normalizeLocalServiceUrl(url: string) {
  try {
    const parsed = new URL(url.trim());
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "0.0.0.0" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "::"
    ) {
      parsed.hostname = "127.0.0.1";
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

export function resolveServiceUrl(
  service: Pick<ServiceEndpoint, "id" | "defaultUrl">,
  draft?: string | null,
) {
  const rawUrl = draft?.trim() || service.defaultUrl;

  try {
    const parsed = new URL(normalizeLocalServiceUrl(rawUrl));
    if (service.id === "napcat" && !parsed.searchParams.get("token")) {
      const defaultParsed = new URL(normalizeLocalServiceUrl(service.defaultUrl));
      const token = defaultParsed.searchParams.get("token");
      if (token) {
        parsed.searchParams.set("token", token);
      }
    }
    return parsed.toString();
  } catch {
    return normalizeLocalServiceUrl(rawUrl);
  }
}

export function sanitizeStoredServiceUrl(serviceId: ServiceId, value?: string | null) {
  const normalized = normalizeLocalServiceUrl(value ?? "");
  if (!normalized) {
    return undefined;
  }

  try {
    const parsed = new URL(normalized);
    if (serviceId === "napcat") {
      parsed.searchParams.delete("token");
    }
    return parsed.toString();
  } catch {
    return normalized;
  }
}

export function sanitizeStoredServiceUrls(
  drafts: Partial<Record<ServiceId, string>>,
): Partial<Record<ServiceId, string>> {
  const sanitized: Partial<Record<ServiceId, string>> = {};

  SERVICE_IDS.forEach((serviceId) => {
    const value = sanitizeStoredServiceUrl(serviceId, drafts[serviceId]);
    if (value) {
      sanitized[serviceId] = value;
    }
  });

  return sanitized;
}

export function sortProcessSnapshots(list: ProcessSnapshot[]) {
  return [...list].sort((left, right) => {
    const leftIndex = PROCESS_ORDER.indexOf(left.id);
    const rightIndex = PROCESS_ORDER.indexOf(right.id);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    return normalizedLeft - normalizedRight;
  });
}

export function stringifyError(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "操作失败，请查看当前面板日志。";
}

export function defaultVoiceConfig(): VoiceChatConfig {
  return {
    asrApiKey: "",
    asrBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    asrTranscriptionPath: "/audio/transcriptions",
    asrModel: "doubao-seed-asr-1-0",
    volcAsrAppId: "",
    volcAsrApiKey: "",
    volcAsrAccessToken: "",
    volcAsrSecretKey: "",
    volcAsrSubmitUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit",
    volcAsrQueryUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query",
    volcAsrUrl: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
    volcAsrResourceId: "volc.seedasr.auc",
    volcAsrModel: "bigmodel",
    ttsApiUrl: "http://127.0.0.1:9880/tts",
    ttsRefAudioPath: "E:\\cha shi bot\\伊蕾娜语音\\reference_audio\\伊蕾娜语音参考\\1.mp3",
    ttsPromptText: "視線を少し下にずらすと、門が見えました。私はそこにほうきを向かわせます。",
    ttsPromptLang: "ja",
    outputLanguage: "zh",
    inputDeviceId: "",
    inputDeviceLabelPattern: "",
    outputDeviceId: "",
    outputDeviceLabelPattern: "CABLE Input",
    maxHistoryTurns: 8,
    bilibiliRoomId: "",
    liveDanmakuReplyEnabled: false,
    liveDanmakuCooldownSeconds: 18,
    gameEventVoiceEnabled: false,
    gameEventVoiceCooldownSeconds: 18,
  };
}

export function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("录音读取失败。"));
        return;
      }
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("录音读取失败。"));
    reader.readAsDataURL(blob);
  });
}

export function makeVoiceLogId() {
  return `voice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getProcessStateLabel(process: ProcessSnapshot) {
  if (!process.running) {
    return "未运行";
  }
  return process.managedByApp ? "运行中" : "外部运行";
}

export function stripAnsiControlCodes(input: string) {
  return input.replace(ANSI_CONTROL_PATTERN, "");
}

export function normalizeAlertDetail(input: string) {
  return stripAnsiControlCodes(input).replace(/\s+/g, " ").trim();
}

export function findLatestLogMatch(
  logLines: string[],
  keywords: string[],
  isRelevantLine: (normalizedLine: string, loweredLine: string) => boolean = () => true,
) {
  const recentLines = logLines.slice(-OFFLINE_ALERT_LOG_WINDOW);

  for (let index = recentLines.length - 1; index >= 0; index -= 1) {
    const normalizedLine = normalizeAlertDetail(recentLines[index] ?? "");
    const loweredLine = normalizedLine.toLowerCase();
    if (
      isRelevantLine(normalizedLine, loweredLine) &&
      keywords.some((keyword) => loweredLine.includes(keyword.toLowerCase()))
    ) {
      return normalizedLine;
    }
  }

  return null;
}

export function joinLocalDataPath(base: string, ...parts: string[]) {
  const normalizedBase = base.replace(/[\\/]+$/, "");
  return [normalizedBase, ...parts].join("\\");
}

function xtermToCssColor(index: number) {
  if (index < 0) {
    return undefined;
  }
  if (index < 8) {
    return BASIC_ANSI_COLORS[index];
  }
  if (index < 16) {
    return BRIGHT_ANSI_COLORS[index - 8];
  }
  if (index < 232) {
    const value = index - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const convert = (part: number) => (part === 0 ? 0 : 55 + part * 40);
    return `rgb(${convert(r)}, ${convert(g)}, ${convert(b)})`;
  }
  if (index < 256) {
    const gray = 8 + (index - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return undefined;
}

function cloneAnsiState(state: AnsiState): AnsiState {
  return { ...state };
}

function applyAnsiCode(state: AnsiState, codes: number[]) {
  if (codes.length === 0) {
    return {};
  }

  const next = cloneAnsiState(state);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      next.color = undefined;
      next.backgroundColor = undefined;
      next.fontWeight = undefined;
      next.fontStyle = undefined;
      next.textDecoration = undefined;
      next.opacity = undefined;
      continue;
    }
    if (code === 1) {
      next.fontWeight = 700;
      continue;
    }
    if (code === 2) {
      next.opacity = 0.7;
      continue;
    }
    if (code === 3) {
      next.fontStyle = "italic";
      continue;
    }
    if (code === 4) {
      next.textDecoration = "underline";
      continue;
    }
    if (code === 22) {
      next.fontWeight = undefined;
      next.opacity = undefined;
      continue;
    }
    if (code === 23) {
      next.fontStyle = undefined;
      continue;
    }
    if (code === 24) {
      next.textDecoration = undefined;
      continue;
    }
    if (code >= 30 && code <= 37) {
      next.color = BASIC_ANSI_COLORS[code - 30];
      continue;
    }
    if (code === 39) {
      next.color = undefined;
      continue;
    }
    if (code >= 40 && code <= 47) {
      next.backgroundColor = BASIC_ANSI_COLORS[code - 40];
      continue;
    }
    if (code === 49) {
      next.backgroundColor = undefined;
      continue;
    }
    if (code >= 90 && code <= 97) {
      next.color = BRIGHT_ANSI_COLORS[code - 90];
      continue;
    }
    if (code >= 100 && code <= 107) {
      next.backgroundColor = BRIGHT_ANSI_COLORS[code - 100];
      continue;
    }
    if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const cssColor = xtermToCssColor(codes[index + 2] ?? -1);
      if (cssColor) {
        if (code === 38) {
          next.color = cssColor;
        } else {
          next.backgroundColor = cssColor;
        }
      }
      index += 2;
    }
  }

  return next;
}

export function renderAnsiText(input: string): ReactNode[] {
  const parts = input.split(ANSI_SPLIT_PATTERN);
  let state: AnsiState = {};
  const nodes: ReactNode[] = [];

  parts.forEach((part, index) => {
    if (!part) {
      return;
    }

    if (ANSI_FULL_TOKEN_PATTERN.test(part)) {
      const codes = part
        .slice(2, -1)
        .split(";")
        .filter((code) => code.length > 0)
        .map((code) => Number.parseInt(code, 10))
        .filter((code) => !Number.isNaN(code));
      state = applyAnsiCode(state, codes);
      return;
    }

    nodes.push(
      <span className="ansi-chunk" key={`ansi-${index}`} style={state}>
        {part}
      </span>,
    );
  });

  return nodes.length > 0 ? nodes : [input];
}

export function renderAnsiLines(lines: string[]) {
  return lines.map((line, index) => (
    <div className="console-line" key={`line-${index}`}>
      {line.length > 0 ? renderAnsiText(line) : "\u00A0"}
    </div>
  ));
}

export async function waitForServiceWindowReady(view: WebviewWindow) {
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const fail = (payload: unknown) => {
        if (!settled) {
          settled = true;
          reject(new Error(payload ? String(payload) : "服务窗口创建失败"));
        }
      };

      void view.once("tauri://created", finish);
      void view.once("tauri://error", (event) => fail((event as { payload?: unknown }).payload));
    }),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1200);
    }),
  ]);
}
