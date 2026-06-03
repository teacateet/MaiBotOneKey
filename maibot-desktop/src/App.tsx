import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  ADAPTER_OFFLINE_KEYWORDS,
  CONSOLE_AUTO_SCROLL_THRESHOLD_PX,
  fallbackEndpoints,
  FORGE_DEBUG_COMMANDS,
  FORGE_RESOURCE_SCAN_TARGETS,
  NAPCAT_OFFLINE_KEYWORDS,
  NATIVE_WEBVIEW_DATA_DIRECTORIES,
  PROCESS_LOG_RENDER_LIMIT,
  PROCESS_POLL_INTERVAL_MS,
  SCREEN_CONTEXT_POLL_INTERVAL_MS,
  SERVICE_WINDOW_LABELS,
  STORAGE_KEY,
} from "./appConstants";
import {
  blobToBase64,
  defaultVoiceConfig,
  findLatestLogMatch,
  getProcessStateLabel,
  isTauriEnvironment,
  joinLocalDataPath,
  loadStoredUrls,
  makeVoiceLogId,
  openExternal,
  renderAnsiLines,
  resolveServiceUrl,
  sanitizeStoredServiceUrls,
  sortProcessSnapshots,
  stringifyError,
  waitForServiceWindowReady,
} from "./appUtils";
import type {
  ForgeBridgeScanResponse,
  ForgeBridgeStatus,
  LoginHelperConfig,
  LoginHelperStatus,
  LoginStabilityReport,
  MaicraftConfig,
  OfflineAlert,
  ProcessSnapshot,
  ServiceEndpoint,
  ServiceId,
  ViewMode,
  VoiceChatConfig,
  VoiceChatLogItem,
  VoiceChatResponse,
} from "./types";
import "./App.css";

const DANMAKU_LOG_PATTERN = /\[弹幕\]\s+(.+?)\(([^()]+)\):\s*(.+)$/;
const ANSI_PATTERN = new RegExp(String.raw`\u001b\[[0-9;]*m`, "g");
const MAX_VOICE_TURN_QUEUE = 3;
const MAX_LIVE_DANMAKU_VOICE_QUEUE = 8;
const MAX_GAME_EVENT_VOICE_QUEUE = 6;
const DEFAULT_MAICRAFT_CONFIG: MaicraftConfig = {
  host: "localhost",
  port: 25565,
  version: "1.20.1",
  username: "MaicraftBot",
  auth: "offline",
  forgeModern: true,
  keepAliveTimeout: 120000,
  goal: "在 Minecraft 服务器里安全生存，并听从管理员指令",
  forgeClientPath: "",
};

const DEFAULT_LOGIN_HELPER_CONFIG: LoginHelperConfig = {
  recipientEmail: "2418749618@qq.com",
  smtpHost: "",
  smtpPort: 587,
  smtpUsername: "",
  smtpPassword: "",
  smtpFrom: "",
  smtpUseSsl: true,
};

function compactGameEventText(value: string, maxLength = 120) {
  const normalized = value
    .replace(ANSI_PATTERN, "")
    .replace(/^\[(out|err|system|reader)\]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

function extractGameVoiceEvent(line: string) {
  const clean = compactGameEventText(line, 220);
  if (!clean || clean.includes("配置加载成功") || clean.includes("加载插件") || clean.includes("缓存")) {
    return null;
  }

  const matchers: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
    [/✅\s*成功连接到服务器并重生/u, () => "我已经进入 Minecraft 服务器并重生了"],
    [/被服务器踢出/u, () => "我被 Minecraft 服务器踢出去了"],
    [/连接断开/u, () => "我和 Minecraft 服务器断开连接了"],
    [/💀\s*玩家死亡/u, () => "我在 Minecraft 里死掉了"],
    [/🎮\s*玩家重生/u, () => "我在 Minecraft 里重生了"],
    [/⚔️\s*进入战斗状态:\s*(.+)$/u, (match) => `我进入战斗状态了：${match[1]}`],
    [/🎯\s*锁定新目标:\s*(.+)$/u, (match) => `我锁定了新的敌人：${match[1]}`],
    [/⚔️\s*攻击目标:\s*(.+)$/u, (match) => `我正在攻击目标：${match[1]}`],
    [/✅\s*成功击杀:\s*(.+)$/u, (match) => `我成功击杀了：${match[1]}`],
    [/⚠️\s*战斗失败:\s*(.+)$/u, (match) => `我的战斗失败了：${match[1]}`],
    [/🎬\s*执行动作:\s*(.+)$/u, (match) => `我准备执行游戏动作：${match[1]}`],
    [/✅\s*动作成功:\s*(.+)$/u, (match) => `我的游戏动作成功了：${match[1]}`],
    [/⚠️\s*动作失败:\s*(.+)$/u, (match) => `我的游戏动作失败了：${match[1]}`],
    [/❌\s*动作执行异常/u, () => "我的游戏动作执行异常了"],
    [/💬\s*(发送聊天|主动聊天):\s*(.+)$/u, (match) => `我在游戏聊天里说：${match[2]}`],
    [/🎯\s*(LLM生成新目标|新目标已创建):\s*(.+)$/u, (match) => `我有了新的游戏目标：${match[2]}`],
    [/移动成功:\s*(.+)$/u, (match) => `我移动到位了：${match[1]}`],
    [/挖掘成功:\s*(.+)$/u, (match) => `我挖掘成功了：${match[1]}`],
    [/合成成功:\s*(.+)$/u, (match) => `我合成成功了：${match[1]}`],
    [/放置方块:\s*(.+)$/u, (match) => `我放置了方块：${match[1]}`],
  ];

  for (const [pattern, buildText] of matchers) {
    const match = clean.match(pattern);
    if (match) {
      return compactGameEventText(buildText(match), 140);
    }
  }

  return null;
}

function createTestToneAudioUrl() {
  const sampleRate = 44100;
  const durationSeconds = 0.42;
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < sampleCount; i += 1) {
    const fade = Math.min(1, i / 1200, (sampleCount - i) / 1200);
    const value = Math.sin((2 * Math.PI * 660 * i) / sampleRate) * 0.22 * fade;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true);
  }

  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function normalizeDeviceName(value: string) {
  return value.trim().toLocaleLowerCase();
}

function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("services");
  const [themePref, setThemePref] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("maibot-theme") as "system" | "light" | "dark") || "system",
  );
  useEffect(() => {
    const root = document.documentElement;
    if (themePref === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = themePref;
    }
    localStorage.setItem("maibot-theme", themePref);
  }, [themePref]);
  const [serviceDefinitions, setServiceDefinitions] = useState<ServiceEndpoint[]>(fallbackEndpoints);
  const [urlDrafts, setUrlDrafts] = useState<Partial<Record<ServiceId, string>>>(loadStoredUrls);
  const [activeServiceId, setActiveServiceId] = useState<ServiceId>("maibot");
  const [openInFrame, setOpenInFrame] = useState(true);
  const [statusText, setStatusText] = useState("正在准备控制台...");
  const [processSnapshots, setProcessSnapshots] = useState<ProcessSnapshot[]>([]);
  const [activeProcessId, setActiveProcessId] = useState<string>("maibot-main");
  const [processStatusText, setProcessStatusText] = useState("进入进程面板后会开始同步内置进程状态。");
  const [processBusy, setProcessBusy] = useState<string | null>(null);
  const [loginStabilityReport, setLoginStabilityReport] =
    useState<LoginStabilityReport | null>(null);
  const [loginHelperConfig, setLoginHelperConfig] =
    useState<LoginHelperConfig>(DEFAULT_LOGIN_HELPER_CONFIG);
  const [loginHelperStatus, setLoginHelperStatus] = useState<LoginHelperStatus | null>(null);
  const [loginHelperStatusText, setLoginHelperStatusText] =
    useState("登录助手尚未刷新。");
  const [loginHelperBusy, setLoginHelperBusy] = useState(false);
  const [logAutoFollow, setLogAutoFollow] = useState(true);
  const [dismissedOfflineAlertIds, setDismissedOfflineAlertIds] = useState<string[]>([]);
  const [maicraftConfig, setMaicraftConfig] = useState<MaicraftConfig>(DEFAULT_MAICRAFT_CONFIG);
  const [maicraftStatusText, setMaicraftStatusText] = useState("游戏配置尚未加载。");
  const [forgeBridgeStatus, setForgeBridgeStatus] = useState<ForgeBridgeStatus | null>(null);
  const [forgeBridgeStatusText, setForgeBridgeStatusText] =
    useState("Forge 桥接未检测。重启 Forge 真客户端后再刷新。");
  const [forgeBridgeBusy, setForgeBridgeBusy] = useState(false);
  const [forgeBridgeChatDraft, setForgeBridgeChatDraft] = useState("小茶桥接测试");
  const [forgeBridgeYsmSearchDraft, setForgeBridgeYsmSearchDraft] = useState("");
  const [forgeBridgeYsmModelDraft, setForgeBridgeYsmModelDraft] = useState("");
  const [forgeBridgeYsmTextureDraft, setForgeBridgeYsmTextureDraft] = useState("-");
  const [forgeBridgeScan, setForgeBridgeScan] = useState<ForgeBridgeScanResponse | null>(null);
  const [showForgeDebugControls, setShowForgeDebugControls] = useState(false);
  const [voiceConfig, setVoiceConfig] = useState<VoiceChatConfig>(defaultVoiceConfig);
  const [voiceStatusText, setVoiceStatusText] = useState("语音对话未开始。");
  const [voiceLogs, setVoiceLogs] = useState<VoiceChatLogItem[]>([]);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceAlwaysOn, setVoiceAlwaysOn] = useState(false);
  const [voiceScreenContextEnabled, setVoiceScreenContextEnabled] = useState(true);
  const [voiceScreenContext, setVoiceScreenContext] = useState("屏幕上下文尚未读取。");
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [latestGameEventVoiceLine, setLatestGameEventVoiceLine] = useState("暂无待处理事件");
  const [nativeDataDirectories, setNativeDataDirectories] = useState<Record<ServiceId, string>>(
    NATIVE_WEBVIEW_DATA_DIRECTORIES,
  );
  const consoleOutputRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const alwaysOnStreamRef = useRef<MediaStream | null>(null);
  const alwaysOnAudioContextRef = useRef<AudioContext | null>(null);
  const alwaysOnAnalyserRef = useRef<AnalyserNode | null>(null);
  const alwaysOnRecorderRef = useRef<MediaRecorder | null>(null);
  const alwaysOnChunksRef = useRef<Blob[]>([]);
  const alwaysOnAnimationRef = useRef<number | null>(null);
  const alwaysOnSegmentTimerRef = useRef<number | null>(null);
  const alwaysOnSpeakingRef = useRef(false);
  const alwaysOnLastVoiceAtRef = useRef(0);
  const alwaysOnCooldownUntilRef = useRef(0);
  const alwaysOnRecordedTypeRef = useRef("audio/webm");
  const voiceTurnQueueRef = useRef<Blob[]>([]);
  const voiceTurnProcessingRef = useRef(false);
  const voicePlaybackQueueRef = useRef<string[]>([]);
  const voicePlaybackActiveRef = useRef(false);
  const voiceAlwaysOnRef = useRef(false);
  const voiceScreenContextRef = useRef("");
  const voiceScreenContextRequestRef = useRef(false);
  const recordingChunksRef = useRef<Blob[]>([]);
  const voiceLogsRef = useRef<VoiceChatLogItem[]>([]);
  const liveDanmakuSeenRef = useRef<Set<string>>(new Set());
  const liveDanmakuPrimedRef = useRef(false);
  const liveDanmakuProcessingRef = useRef(false);
  const liveDanmakuQueueRef = useRef<{ id: string; nickname: string; text: string }[]>([]);
  const liveDanmakuLastReplyAtRef = useRef(0);
  const gameEventSeenRef = useRef<Set<string>>(new Set());
  const gameEventPrimedRef = useRef(false);
  const gameEventProcessingRef = useRef(false);
  const gameEventQueueRef = useRef<{ id: string; eventText: string }[]>([]);
  const gameEventLastReplyAtRef = useRef(0);
  const serviceWindowUrlsRef = useRef<Partial<Record<ServiceId, string>>>({});

  useEffect(() => {
    voiceAlwaysOnRef.current = voiceAlwaysOn;
  }, [voiceAlwaysOn]);

  useEffect(() => {
    voiceScreenContextRef.current = voiceScreenContext;
  }, [voiceScreenContext]);

  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setVoiceStatusText("当前 WebView 不支持枚举音频设备。");
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((device) => device.kind === "audioinput");
      const outputs = devices.filter((device) => device.kind === "audiooutput");
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      if (inputs.length === 0 && outputs.length === 0) {
        setVoiceStatusText("没有读到可选音频设备；如果列表为空，先点一次“授权刷新设备列表”。");
      }
    } catch (error) {
      setVoiceStatusText(`读取音频设备失败：${stringifyError(error)}`);
    }
  }, []);

  const requestAudioDevicePermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceStatusText("当前 WebView 不支持请求音频设备权限。");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await refreshAudioDevices();
      setVoiceStatusText("音频设备权限已刷新。现在可以选择监听输入和虚拟声卡输出。");
    } catch (error) {
      setVoiceStatusText(`音频设备授权失败：${stringifyError(error)}`);
    }
  }, [refreshAudioDevices]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshAudioDevices(), 0);
    if (!navigator.mediaDevices?.addEventListener) {
      return () => window.clearTimeout(timer);
    }
    navigator.mediaDevices.addEventListener("devicechange", refreshAudioDevices);
    return () => {
      window.clearTimeout(timer);
      navigator.mediaDevices.removeEventListener("devicechange", refreshAudioDevices);
    };
  }, [refreshAudioDevices]);

  useEffect(() => {
    if (!voiceAlwaysOn || !voiceScreenContextEnabled || !isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    const refreshScreenContext = async () => {
      if (document.hidden) {
        return;
      }
      if (voiceScreenContextRequestRef.current) {
        return;
      }
      voiceScreenContextRequestRef.current = true;
      try {
        const context = await invoke<string>("get_realtime_screen_context");
        if (!disposed && context !== voiceScreenContextRef.current) {
          setVoiceScreenContext(context);
        }
      } catch (error) {
        if (!disposed) {
          setVoiceScreenContext(`屏幕上下文读取失败：${stringifyError(error)}`);
        }
      } finally {
        voiceScreenContextRequestRef.current = false;
      }
    };

    void refreshScreenContext();
    const timer = window.setInterval(() => void refreshScreenContext(), SCREEN_CONTEXT_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [voiceAlwaysOn, voiceScreenContextEnabled]);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    appLocalDataDir()
      .then((baseDir) => {
        if (disposed) {
          return;
        }
        setNativeDataDirectories({
          maibot: joinLocalDataPath(baseDir, "embedded-webviews", "maibot"),
          napcat: joinLocalDataPath(baseDir, "embedded-webviews", "napcat"),
        });
      })
      .catch(() => {
        setNativeDataDirectories(NATIVE_WEBVIEW_DATA_DIRECTORIES);
        setStatusText("原生 Webview 会话目录解析失败，已回退为兼容目录。");
      });

    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    invoke<ServiceEndpoint[]>("get_service_endpoints")
      .then((definitions) => {
        if (definitions.length > 0) {
          setServiceDefinitions(definitions);
          setStatusText("本地服务入口已加载，可以直接嵌入或切到浏览器处理故障。");
        } else {
          setStatusText("未从后端拿到服务入口，已回退到默认地址。");
        }
      })
      .catch(() => {
        setStatusText("正在使用前端默认地址。后面接入真实进程管理后，这里会改成自动探测。");
      });
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    invoke<MaicraftConfig>("get_maicraft_config")
      .then((config) => {
        setMaicraftConfig(config);
        setMaicraftStatusText("游戏配置已加载，可以直接修改服务器地址后保存。");
      })
      .catch((error) => {
        setMaicraftStatusText(`游戏配置加载失败：${stringifyError(error)}`);
      });
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    invoke<VoiceChatConfig>("get_voice_chat_config")
      .then((config) => {
        setVoiceConfig(config);
        setVoiceStatusText("语音配置已加载，默认输出中文。");
      })
      .catch((error) => {
        setVoiceStatusText(`语音配置加载失败：${stringifyError(error)}`);
      });
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    Promise.all([
      invoke<LoginHelperConfig>("get_login_helper_config"),
      invoke<LoginHelperStatus>("get_login_helper_status"),
    ])
      .then(([config, helperStatus]) => {
        setLoginHelperConfig(config);
        setLoginHelperStatus(helperStatus);
        setLoginHelperStatusText("登录助手已读取 MaiBot / NapCat 当前入口。");
      })
      .catch((error) => {
        setLoginHelperStatusText(`登录助手加载失败：${stringifyError(error)}`);
      });
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeStoredServiceUrls(urlDrafts)));
  }, [urlDrafts]);

  useEffect(() => {
    if (
      !["processes", "live", "game"].includes(viewMode) &&
      !voiceConfig.liveDanmakuReplyEnabled &&
      !voiceConfig.gameEventVoiceEnabled
    ) {
      return undefined;
    }

    let disposed = false;

    const refresh = async (silent: boolean) => {
      if (silent && document.hidden) {
        return;
      }
      try {
        const [rawSnapshots, stabilityReport] = await Promise.all([
          invoke<ProcessSnapshot[]>("get_process_snapshots"),
          invoke<LoginStabilityReport>("get_login_stability_report"),
        ]);
        const snapshots = sortProcessSnapshots(rawSnapshots);
        if (disposed) {
          return;
        }
        setProcessSnapshots(snapshots);
        setLoginStabilityReport(stabilityReport);
        setActiveProcessId((current) => {
          if (snapshots.some((item) => item.id === current)) {
            return current;
          }
          return snapshots[0]?.id ?? current;
        });
        if (!silent) {
          setProcessStatusText("主程序、Adapter、NapCat 和语音 API 已接入软件内面板，不再需要外部 cmd。");
        }
      } catch (error) {
        if (disposed) {
          return;
        }
        setProcessStatusText(`进程面板连接失败：${stringifyError(error)}`);
      }
    };

    void refresh(false);
    const timer = window.setInterval(() => void refresh(true), PROCESS_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [viewMode, voiceConfig.gameEventVoiceEnabled, voiceConfig.liveDanmakuReplyEnabled]);

  const resolvedServices = useMemo(
    () =>
      serviceDefinitions.map((service) => ({
        ...service,
        url: urlDrafts[service.id]?.trim() || service.defaultUrl,
        effectiveUrl: resolveServiceUrl(service, urlDrafts[service.id]),
      })),
    [serviceDefinitions, urlDrafts],
  );

  const refreshServiceDefinitions = useCallback(async () => {
    try {
      const definitions = await invoke<ServiceEndpoint[]>("get_service_endpoints");
      if (definitions.length > 0) {
        setServiceDefinitions(definitions);
        return definitions;
      }
    } catch {
      // ignore and keep current definitions
    }

    return serviceDefinitions;
  }, [serviceDefinitions]);

  const resolveFreshServiceUrl = useCallback(
    async (service: { id: ServiceId; defaultUrl: string }) => {
      const latestDefinitions = await refreshServiceDefinitions();
      const latestService = latestDefinitions.find((item) => item.id === service.id) ?? service;
      return resolveServiceUrl(latestService, urlDrafts[service.id]);
    },
    [refreshServiceDefinitions, urlDrafts],
  );

  const openServiceExternally = useCallback(
    async (service: { id: ServiceId; defaultUrl: string }) => {
      await openExternal(await resolveFreshServiceUrl(service));
    },
    [resolveFreshServiceUrl],
  );

  const activeService =
    resolvedServices.find((service) => service.id === activeServiceId) ?? resolvedServices[0];

  const orderedProcesses = useMemo(
    () => sortProcessSnapshots(processSnapshots),
    [processSnapshots],
  );
  const liveProcess = orderedProcesses.find((process) => process.id === "bilibili-live");
  const gameProcess = orderedProcesses.find((process) => process.id === "maicraft-next");
  const forgeClientProcess = orderedProcesses.find((process) => process.id === "forge-client");
  const forgeAgentProcess = orderedProcesses.find((process) => process.id === "forge-agent");
  const ttsProcess = orderedProcesses.find((process) => process.id === "tts-api");

  const activeProcess =
    orderedProcesses.find((process) => process.id === activeProcessId) ?? orderedProcesses[0];
  const activeProcessLastLogLine =
    activeProcess?.logLines[activeProcess.logLines.length - 1] ?? "";
  const visibleActiveProcessLogLines = useMemo(
    () => activeProcess?.logLines.slice(-PROCESS_LOG_RENDER_LIMIT) ?? [],
    [activeProcess?.logLines],
  );
  const renderedActiveProcessLogs = useMemo(
    () => renderAnsiLines(visibleActiveProcessLogLines),
    [visibleActiveProcessLogLines],
  );
  const hasExternalProcess = orderedProcesses.some((process) => process.runningExternally);
  const maicraftEndpoint = `${maicraftConfig.host || "localhost"}:${maicraftConfig.port || 25565}`;
  const gameServerRefused = Boolean(
    gameProcess?.logLines.some((line) => {
      const loweredLine = line.toLowerCase();
      return (
        (loweredLine.includes("econnrefused") || loweredLine.includes("connection refused")) &&
        line.includes(String(maicraftConfig.port || 25565))
      );
    }),
  );
  const gameServerRequiresForge = Boolean(
    gameProcess?.logLines.some((line) => /forge|fml|mods that require forge/i.test(line)),
  );
  const gameServerStatusText = gameServerRequiresForge
    ? `Minecraft 服务器拒绝连接：${maicraftEndpoint} 要求 1.20.1 Forge 客户端和对应整合包。可以先打开“现代 Forge/FML3 协议实验兼容”；若服务器强校验客户端 mod，再改用 Forge 真客户端 + Forge 控制AI。`
    : gameServerRefused
    ? `Minecraft 服务器未连接：${maicraftEndpoint} 当前拒绝连接。先启动服务器，或保存正确的域名和端口。`
    : gameProcess?.running
      ? `Maicraft Next 正在运行，目标服务器：${maicraftEndpoint}。`
      : "Maicraft Next 已安装，等待启动。";
  const resolvedVoiceInputDevice = useMemo(() => {
    const selectedId = voiceConfig.inputDeviceId.trim();
    if (selectedId) {
      return audioInputDevices.find((device) => device.deviceId === selectedId) ?? null;
    }
    const pattern = normalizeDeviceName(voiceConfig.inputDeviceLabelPattern);
    if (!pattern) {
      return null;
    }
    return (
      audioInputDevices.find((device) => normalizeDeviceName(device.label).includes(pattern)) ??
      null
    );
  }, [audioInputDevices, voiceConfig.inputDeviceId, voiceConfig.inputDeviceLabelPattern]);
  const resolvedVoiceOutputDevice = useMemo(() => {
    const selectedId = voiceConfig.outputDeviceId.trim();
    if (selectedId) {
      return audioOutputDevices.find((device) => device.deviceId === selectedId) ?? null;
    }
    const pattern = normalizeDeviceName(voiceConfig.outputDeviceLabelPattern);
    if (!pattern) {
      return null;
    }
    return (
      audioOutputDevices.find((device) => normalizeDeviceName(device.label).includes(pattern)) ??
      null
    );
  }, [audioOutputDevices, voiceConfig.outputDeviceId, voiceConfig.outputDeviceLabelPattern]);
  const resolvedVoiceInputDeviceId = resolvedVoiceInputDevice?.deviceId ?? "";
  const resolvedVoiceOutputDeviceId = resolvedVoiceOutputDevice?.deviceId ?? "";
  const resolvedVoiceInputText = resolvedVoiceInputDevice
    ? resolvedVoiceInputDevice.label || "已匹配的音频输入设备"
    : voiceConfig.inputDeviceLabelPattern.trim()
      ? `未匹配到：${voiceConfig.inputDeviceLabelPattern}`
      : "系统默认麦克风";
  const resolvedVoiceOutputText = resolvedVoiceOutputDevice
    ? resolvedVoiceOutputDevice.label || "已匹配的音频输出设备"
    : voiceConfig.outputDeviceLabelPattern.trim()
      ? `未匹配到：${voiceConfig.outputDeviceLabelPattern}`
      : "系统默认输出";
  const getVoiceAudioConstraints = useCallback((): MediaStreamConstraints => {
    const selectedInputId = resolvedVoiceInputDeviceId.trim();
    const wantsSpecificInput =
      voiceConfig.inputDeviceId.trim().length > 0 ||
      voiceConfig.inputDeviceLabelPattern.trim().length > 0;

    if (wantsSpecificInput && !selectedInputId) {
      throw new Error(`没有匹配到语音监听输入设备：${resolvedVoiceInputText}`);
    }

    if (selectedInputId) {
      return {
        audio: {
          deviceId: { exact: selectedInputId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      };
    }

    return {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    };
  }, [
    resolvedVoiceInputDeviceId,
    resolvedVoiceInputText,
    voiceConfig.inputDeviceId,
    voiceConfig.inputDeviceLabelPattern,
  ]);
  const loginRiskMessages = loginStabilityReport?.riskMessages ?? [];
  const hasLoginStabilityRisk = loginRiskMessages.length > 0;
  const normalQqCount = loginStabilityReport?.normalQqProcesses.length ?? 0;
  const napcatQqCount = loginStabilityReport?.napcatQqProcesses.length ?? 0;
  const napcatBootCount = loginStabilityReport?.napcatBootProcesses.length ?? 0;
  const offlineAlerts = useMemo(() => {
    const alerts: OfflineAlert[] = [];
    const isNapCatSystemLine = (_line: string, loweredLine: string) =>
      loweredLine.includes("[napcat]") ||
      loweredLine.includes("[onebot] [websocket") ||
      loweredLine.includes("[websocket client]") ||
      loweredLine.includes("[notice] [onebot11] [network]") ||
      loweredLine.includes("快速登录") ||
      loweredLine.includes("登录态") ||
      loweredLine.includes("用户身份已失效") ||
      loweredLine.includes("被踢下线") ||
      loweredLine.includes("econnrefused") ||
      loweredLine.includes("connection refused");
    const isAdapterLinkLine = (_line: string, loweredLine: string) =>
      /\|\s*(adapter|maim_message)\s*\|/i.test(loweredLine) ||
      loweredLine.includes("[adapter]") ||
      loweredLine.includes("[maim_message]");

    const buildAlert = (
      processId: string,
      title: string,
      summary: string,
      keywords: string[],
      isRelevantLine: (normalizedLine: string, loweredLine: string) => boolean,
    ) => {
      const process = orderedProcesses.find((item) => item.id === processId);
      if (!process) {
        return;
      }

      const detail = findLatestLogMatch(process.logLines, keywords, isRelevantLine);
      if (!detail) {
        return;
      }

      alerts.push({
        id: `${process.id}:${detail}`,
        processId: process.id,
        title,
        summary,
        detail,
      });
    };

    buildAlert(
      "napcat",
      "QQ 登录异常",
      "NapCat 最近出现掉线或登录错误，可能需要重新登录或执行深度清理。",
      NAPCAT_OFFLINE_KEYWORDS,
      isNapCatSystemLine,
    );
    buildAlert(
      "adapter",
      "QQ 消息链路异常",
      "Adapter 检测到 QQ 链路断开，当前 bot 可能不回复或发不出去消息。",
      ADAPTER_OFFLINE_KEYWORDS,
      isAdapterLinkLine,
    );

    return alerts;
  }, [orderedProcesses]);
  const visibleOfflineAlerts = useMemo(
    () => offlineAlerts.filter((alert) => !dismissedOfflineAlertIds.includes(alert.id)),
    [dismissedOfflineAlertIds, offlineAlerts],
  );

  const scrollConsoleTo = useCallback(
    (position: "top" | "bottom", behavior: ScrollBehavior = "smooth") => {
      const node = consoleOutputRef.current;
      if (!node) {
        return;
      }

      if (position === "top") {
        node.scrollTo({ top: 0, behavior });
        setLogAutoFollow(false);
        return;
      }

      node.scrollTo({ top: node.scrollHeight, behavior });
      setLogAutoFollow(true);
    },
    [],
  );

  const focusProcessLog = useCallback((processId: string, reason: string) => {
    setViewMode("processes");
    setActiveProcessId(processId);
    setProcessStatusText(reason);
    setLogAutoFollow(true);
  }, []);

  const openModuleLog = useCallback((processId: string, reason: string) => {
    focusProcessLog(processId, reason);
  }, [focusProcessLog]);

  const openProcessPanel = useCallback(() => {
    setViewMode("processes");
    setLogAutoFollow(true);
  }, []);

  const refreshForgeBridgeStatus = useCallback(async () => {
    try {
      const rawStatus = await invoke<string>("forge_bridge_status");
      const parsedStatus = JSON.parse(rawStatus) as ForgeBridgeStatus;
      setForgeBridgeStatus(parsedStatus);
      if (parsedStatus.connected) {
        const position =
          typeof parsedStatus.x === "number" &&
          typeof parsedStatus.y === "number" &&
          typeof parsedStatus.z === "number"
            ? `，坐标 ${parsedStatus.x.toFixed(1)}, ${parsedStatus.y.toFixed(1)}, ${parsedStatus.z.toFixed(1)}`
            : "";
        setForgeBridgeStatusText(`Forge 桥接已连接：${parsedStatus.name ?? "未知玩家"}${position}`);
      } else {
        setForgeBridgeStatusText("Forge 桥接端口已响应，但当前还没进入世界。");
      }
      return parsedStatus;
    } catch (error) {
      setForgeBridgeStatus(null);
      setForgeBridgeStatusText(stringifyError(error));
      throw error;
    }
  }, []);

  const runForgeBridgeCommand = useCallback(
    async (
      request: Record<string, unknown>,
      pendingText: string,
      doneText: string,
      refreshAfter = true,
    ) => {
      setForgeBridgeBusy(true);
      setForgeBridgeStatusText(pendingText);
      try {
        const rawResult = await invoke<string>("forge_bridge_command", { request });
        try {
          const parsedResult = JSON.parse(rawResult) as { ok?: boolean; message?: string; error?: string };
          if (parsedResult.ok === false) {
            throw new Error(parsedResult.message ?? parsedResult.error ?? "桥接端返回失败。");
          }
        } catch (parseOrBridgeError) {
          if (parseOrBridgeError instanceof SyntaxError) {
            // Older bridge commands only return plain success text; keep them compatible.
          } else {
            throw parseOrBridgeError;
          }
        }
        setForgeBridgeStatusText(doneText);
        if (refreshAfter) {
          await refreshForgeBridgeStatus();
        }
      } catch (error) {
        setForgeBridgeStatusText(`Forge 桥接指令失败：${stringifyError(error)}`);
      } finally {
        setForgeBridgeBusy(false);
      }
    },
    [refreshForgeBridgeStatus],
  );

  const scanForgeBridgeBlocks = useCallback(async (targets = "", radius = 8, limit = 24) => {
    setForgeBridgeBusy(true);
    setForgeBridgeStatusText("正在扫描 Forge 客户端附近方块...");
    try {
      const rawScan = await invoke<string>("forge_bridge_scan", { targets, radius, limit });
      const parsedScan = JSON.parse(rawScan) as ForgeBridgeScanResponse;
      setForgeBridgeScan(parsedScan);
      setForgeBridgeStatusText(`附近扫描完成：找到 ${parsedScan.blocks?.length ?? 0} 个方块。`);
      return parsedScan;
    } catch (error) {
      setForgeBridgeStatusText(`Forge 方块扫描失败：${stringifyError(error)}`);
      throw error;
    } finally {
      setForgeBridgeBusy(false);
    }
  }, []);

  const sendForgeBridgeChat = useCallback(async () => {
    const text = forgeBridgeChatDraft.trim();
    if (!text) {
      setForgeBridgeStatusText("Minecraft 聊天内容不能为空。");
      return;
    }
    setForgeBridgeBusy(true);
    setForgeBridgeStatusText("正在通过 Forge 真客户端发送聊天...");
    try {
      await invoke<string>("forge_bridge_chat", { text });
      setForgeBridgeStatusText(`已发送 Minecraft 聊天：${text}`);
      await refreshForgeBridgeStatus();
    } catch (error) {
      setForgeBridgeStatusText(`Forge 聊天发送失败：${stringifyError(error)}`);
    } finally {
      setForgeBridgeBusy(false);
    }
  }, [forgeBridgeChatDraft, refreshForgeBridgeStatus]);

  const openForgeBridgeYsmMenu = useCallback(async () => {
    const search = forgeBridgeYsmSearchDraft.trim();
    await runForgeBridgeCommand(
      { ...FORGE_DEBUG_COMMANDS.ysmOpenMenu, search },
      search ? `正在打开 YSM 模型菜单，并搜索：${search}` : "正在打开 YSM 模型菜单...",
      search ? "已打开 YSM 模型菜单，并尝试填入搜索词。" : "已打开 YSM 模型菜单。",
    );
  }, [forgeBridgeYsmSearchDraft, runForgeBridgeCommand]);

  const setForgeBridgeYsmModel = useCallback(async () => {
    const modelId = forgeBridgeYsmModelDraft.trim();
    const textureId = forgeBridgeYsmTextureDraft.trim() || "-";
    if (!modelId) {
      setForgeBridgeStatusText("YSM 模型 ID 不能为空。先在菜单里确认模型 ID，再切换。");
      return;
    }
    await runForgeBridgeCommand(
      {
        action: "ysm_set_model",
        modelId,
        textureId,
        target: "@s",
        ignoreAuth: true,
      },
      `正在切换 YSM 模型：${modelId}...`,
      `已发送 YSM 模型切换指令：${modelId}${textureId === "-" ? "" : ` / ${textureId}`}。`,
    );
  }, [forgeBridgeYsmModelDraft, forgeBridgeYsmTextureDraft, runForgeBridgeCommand]);

  const runForgeBridgePatrolTest = useCallback(async () => {
    setForgeBridgeBusy(true);
    setForgeBridgeStatusText("正在执行 Forge 桥接巡逻测试...");
    const steps = [
      { action: "move", forward: true, sprint: true, duration: 900 },
      { action: "jump" },
      { action: "move", left: true, duration: 450 },
      { action: "move", forward: true, duration: 650 },
      { action: "move", right: true, duration: 450 },
      { action: "stop" },
    ];

    try {
      for (const request of steps) {
        await invoke<string>("forge_bridge_command", { request });
        await new Promise((resolve) => window.setTimeout(resolve, Number(request.duration ?? 260) + 120));
      }
      setForgeBridgeStatusText("Forge 桥接巡逻测试完成。");
      await refreshForgeBridgeStatus();
    } catch (error) {
      setForgeBridgeStatusText(`Forge 桥接巡逻测试失败：${stringifyError(error)}`);
    } finally {
      setForgeBridgeBusy(false);
    }
  }, [refreshForgeBridgeStatus]);

  const selectProcess = useCallback((processId: string) => {
    setActiveProcessId(processId);
    setLogAutoFollow(true);
  }, []);

  const handleConsoleScroll = useCallback(() => {
    const node = consoleOutputRef.current;
    if (!node) {
      return;
    }

    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setLogAutoFollow((current) => {
      const next = distanceToBottom <= CONSOLE_AUTO_SCROLL_THRESHOLD_PX;
      return current === next ? current : next;
    });
  }, []);

  const openServiceWindow = useCallback(
    async (service: { id: ServiceId; name: string; url: string; defaultUrl: string }) => {
      const targetUrl = await resolveFreshServiceUrl(service);

      if (!isTauriEnvironment()) {
        await openExternal(targetUrl);
        return;
      }

      const label = SERVICE_WINDOW_LABELS[service.id];
      let win = await WebviewWindow.getByLabel(label);
      const previousUrl = serviceWindowUrlsRef.current[service.id];

      if (win && previousUrl && previousUrl !== targetUrl) {
        await win.close().catch(() => undefined);
        win = null;
      }

      if (!win) {
        win = new WebviewWindow(label, {
          url: targetUrl,
          title: `${service.name} · 软件内小窗`,
          width: 1180,
          height: 820,
          minWidth: 900,
          minHeight: 640,
          resizable: true,
          center: true,
          focus: true,
          visible: true,
          dataDirectory: nativeDataDirectories[service.id],
        });
        await waitForServiceWindowReady(win);
      }

      serviceWindowUrlsRef.current[service.id] = targetUrl;
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
      setStatusText(`${service.name} 已在软件内小窗打开，不再走主界面内嵌。`);
    },
    [nativeDataDirectories, resolveFreshServiceUrl],
  );

  useEffect(() => {
    if (viewMode !== "processes" || !activeProcess || !logAutoFollow) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const node = consoleOutputRef.current;
      if (!node) {
        return;
      }
      node.scrollTop = node.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeProcess,
    activeProcessLastLogLine,
    logAutoFollow,
    viewMode,
  ]);

  const refreshProcessSnapshots = useCallback(async () => {
    const [rawSnapshots, stabilityReport] = await Promise.all([
      invoke<ProcessSnapshot[]>("get_process_snapshots"),
      invoke<LoginStabilityReport>("get_login_stability_report"),
    ]);
    const snapshots = sortProcessSnapshots(rawSnapshots);
    setProcessSnapshots(snapshots);
    setLoginStabilityReport(stabilityReport);
    if (snapshots.length > 0) {
      setActiveProcessId((current) => {
        if (snapshots.some((item) => item.id === current)) {
          return current;
        }
        return snapshots[0].id;
      });
    }
    return snapshots;
  }, []);

  const runProcessAction = useCallback(
    async (
      command: string,
      args: Record<string, unknown> | undefined,
      pendingText: string,
      doneText: string,
    ) => {
      setProcessBusy(command);
      setProcessStatusText(pendingText);

      try {
        const snapshots = sortProcessSnapshots(await invoke<ProcessSnapshot[]>(command, args));
        setProcessSnapshots(snapshots);
        try {
          setLoginStabilityReport(await invoke<LoginStabilityReport>("get_login_stability_report"));
        } catch {
          setLoginStabilityReport(null);
        }
        if (snapshots.length > 0) {
          setActiveProcessId((current) => {
            if (snapshots.some((item) => item.id === current)) {
              return current;
            }
            return snapshots[0].id;
          });
        }
        setProcessStatusText(doneText);
      } catch (error) {
        const actionError = stringifyError(error);

        try {
          await refreshProcessSnapshots();
          setProcessStatusText(`${pendingText}失败：${actionError}`);
        } catch (refreshError) {
          setProcessStatusText(
            `${pendingText}失败：${actionError}；状态刷新也失败：${stringifyError(refreshError)}`,
          );
        }
      } finally {
        setProcessBusy(null);
      }
    },
    [refreshProcessSnapshots],
  );

  const updateVoiceConfig = useCallback(
    <K extends keyof VoiceChatConfig>(key: K, value: VoiceChatConfig[K]) => {
      setVoiceConfig((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const updateMaicraftConfig = useCallback(
    <K extends keyof MaicraftConfig>(key: K, value: MaicraftConfig[K]) => {
      setMaicraftConfig((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const updateLoginHelperConfig = useCallback(
    <K extends keyof LoginHelperConfig>(key: K, value: LoginHelperConfig[K]) => {
      setLoginHelperConfig((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const refreshLoginHelperStatus = useCallback(async () => {
    const helperStatus = await invoke<LoginHelperStatus>("get_login_helper_status");
    setLoginHelperStatus(helperStatus);
    setLoginHelperStatusText("登录助手已刷新 MaiBot / NapCat 当前入口。");
    return helperStatus;
  }, []);

  const saveLoginHelperConfig = useCallback(async () => {
    setLoginHelperBusy(true);
    setLoginHelperStatusText("正在保存登录助手邮件配置...");
    try {
      const savedConfig = await invoke<LoginHelperConfig>("save_login_helper_config", {
        config: loginHelperConfig,
      });
      setLoginHelperConfig(savedConfig);
      const helperStatus = await invoke<LoginHelperStatus>("get_login_helper_status");
      setLoginHelperStatus(helperStatus);
      setLoginHelperStatusText("登录助手邮件配置已保存。");
      return savedConfig;
    } catch (error) {
      setLoginHelperStatusText(`登录助手配置保存失败：${stringifyError(error)}`);
      throw error;
    } finally {
      setLoginHelperBusy(false);
    }
  }, [loginHelperConfig]);

  const sendLoginHelperEmail = useCallback(async () => {
    setLoginHelperBusy(true);
    setLoginHelperStatusText("正在发送登录助手邮件...");
    try {
      const message = await invoke<string>("send_login_helper_email", {
        request: {
          config: loginHelperConfig,
          includeMaibot: true,
          includeNapcat: true,
        },
      });
      const helperStatus = await invoke<LoginHelperStatus>("get_login_helper_status");
      setLoginHelperStatus(helperStatus);
      setLoginHelperStatusText(message);
    } catch (error) {
      setLoginHelperStatusText(`登录助手邮件发送失败：${stringifyError(error)}`);
    } finally {
      setLoginHelperBusy(false);
    }
  }, [loginHelperConfig]);

  const persistMaicraftConfig = useCallback(async (startAfterSave = false) => {
    setProcessBusy("maicraft-config");
    setMaicraftStatusText("正在保存 Maicraft Next 游戏配置...");
    try {
      const savedConfig = await invoke<MaicraftConfig>("save_maicraft_config", {
        config: maicraftConfig,
      });
      setMaicraftConfig(savedConfig);
      const endpoint = `${savedConfig.host}:${savedConfig.port}`;
      setMaicraftStatusText(`游戏配置已保存：${endpoint}。`);
      if (startAfterSave) {
        await runProcessAction(
          "start_managed_process",
          { processId: "maicraft-next" },
          "配置已保存，正在启动 Maicraft Next 游戏Bot...",
          "Maicraft Next 游戏Bot 启动请求已发送。",
        );
      }
      return savedConfig;
    } catch (error) {
      const message = stringifyError(error);
      setMaicraftStatusText(`游戏配置保存失败：${message}`);
      throw error;
    } finally {
      setProcessBusy(null);
    }
  }, [maicraftConfig, runProcessAction]);

  const persistVoiceConfig = useCallback(async (config: VoiceChatConfig) => {
    const savedConfig = await invoke<VoiceChatConfig>("save_voice_chat_config", {
      config,
    });
    setVoiceConfig(savedConfig);
    return savedConfig;
  }, []);

  const stopAlwaysOnVoice = useCallback(() => {
    setVoiceAlwaysOn(false);
    voiceAlwaysOnRef.current = false;
    if (alwaysOnAnimationRef.current !== null) {
      window.clearInterval(alwaysOnAnimationRef.current);
      alwaysOnAnimationRef.current = null;
    }
    if (alwaysOnSegmentTimerRef.current !== null) {
      window.clearTimeout(alwaysOnSegmentTimerRef.current);
      alwaysOnSegmentTimerRef.current = null;
    }
    const recorder = alwaysOnRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    alwaysOnRecorderRef.current = null;
    alwaysOnChunksRef.current = [];
    alwaysOnStreamRef.current?.getTracks().forEach((track) => track.stop());
    alwaysOnStreamRef.current = null;
    void alwaysOnAudioContextRef.current?.close().catch(() => undefined);
    alwaysOnAudioContextRef.current = null;
    alwaysOnAnalyserRef.current = null;
    alwaysOnSpeakingRef.current = false;
    setVoiceStatusText("常开语音对话已关闭。");
  }, []);

  const playVoiceAudio = useCallback((audioUrl: string) => {
    const startPlayback = async (nextAudioUrl: string) => {
      const shouldWaitForUser =
        voiceAlwaysOnRef.current && (alwaysOnSpeakingRef.current || alwaysOnRecorderRef.current !== null);
      if (shouldWaitForUser) {
        voicePlaybackQueueRef.current.unshift(nextAudioUrl);
        setVoiceStatusText("回复语音已准备好，等待你说完后播放。");
        return;
      }
      if (voicePlaybackActiveRef.current) {
        voicePlaybackQueueRef.current.push(nextAudioUrl);
        return;
      }

      voicePlaybackActiveRef.current = true;
      const audio = new Audio(nextAudioUrl) as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      const finishPlayback = () => {
        voicePlaybackActiveRef.current = false;
        alwaysOnCooldownUntilRef.current = performance.now() + 620;
        const queuedAudioUrl = voicePlaybackQueueRef.current.shift();
        if (queuedAudioUrl) {
          window.setTimeout(() => void startPlayback(queuedAudioUrl), 80);
        }
      };
      audio.onended = finishPlayback;
      const outputDeviceId = resolvedVoiceOutputDeviceId;
      if (outputDeviceId && audio.setSinkId) {
        try {
          await audio.setSinkId(outputDeviceId);
        } catch (error) {
          setVoiceStatusText(`切换语音输出设备失败，已回退默认输出：${stringifyError(error)}`);
        }
      } else if (outputDeviceId && !audio.setSinkId) {
        setVoiceStatusText("当前 WebView 不支持选择音频输出设备，已使用默认输出。");
      }
      void audio.play().catch(finishPlayback);
    };

    void startPlayback(audioUrl);
  }, [resolvedVoiceOutputDeviceId]);

  const appendVoiceResponseLog = useCallback(
    (response: VoiceChatResponse, audioUrl: string) => {
      const nextItem: VoiceChatLogItem = {
        id: makeVoiceLogId(),
        transcript: response.transcript,
        replyText: response.replyText,
        audioUrl,
        asrModel: response.asrModel,
        replyModel: response.replyModel,
      };
      setVoiceLogs((current) => {
        const next = [nextItem, ...current];
        next.slice(20).forEach((item) => URL.revokeObjectURL(item.audioUrl));
        return next.slice(0, 20);
      });
    },
    [],
  );

  const responseToAudioUrl = useCallback((response: VoiceChatResponse) => {
    const audioBytes = Uint8Array.from(atob(response.audioBase64), (char) => char.charCodeAt(0));
    const audioBlob = new Blob([audioBytes], { type: response.audioMime || "audio/wav" });
    return URL.createObjectURL(audioBlob);
  }, []);

  const saveVoiceConfig = useCallback(async () => {
    setVoiceBusy(true);
    setVoiceStatusText("正在保存语音配置...");
    try {
      await persistVoiceConfig(voiceConfig);
      setVoiceStatusText("语音配置已保存。");
    } catch (error) {
      setVoiceStatusText(`语音配置保存失败：${stringifyError(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  }, [persistVoiceConfig, voiceConfig]);

  const clearVoiceHistory = useCallback(async () => {
    setVoiceBusy(true);
    setVoiceStatusText("正在清空语音上下文...");
    try {
      await invoke("clear_voice_chat_history");
      voiceLogs.forEach((item) => URL.revokeObjectURL(item.audioUrl));
      setVoiceLogs([]);
      setVoiceStatusText("语音上下文已清空。");
    } catch (error) {
      setVoiceStatusText(`清空语音上下文失败：${stringifyError(error)}`);
    } finally {
      setVoiceBusy(false);
    }
  }, [voiceLogs]);

  const processVoiceTurnQueue = useCallback(
    async () => {
      if (voiceTurnProcessingRef.current) {
        return;
      }
      voiceTurnProcessingRef.current = true;
      setVoiceBusy(true);
      try {
        while (voiceTurnQueueRef.current.length > 0) {
          const blob = voiceTurnQueueRef.current.shift();
          if (!blob) {
            break;
          }
          const queuedCount = voiceTurnQueueRef.current.length;
          setVoiceStatusText(
            queuedCount > 0
              ? `正在识别分段语音，后面还有 ${queuedCount} 段待处理...`
              : "正在识别语音并准备伊蕾娜语音回复...",
          );
          const audioBase64 = await blobToBase64(blob);
          const response = await invoke<VoiceChatResponse>("voice_chat_turn", {
            request: {
              audioBase64,
              mimeType: blob.type || "audio/webm",
              config: voiceConfig,
              screenContext: voiceScreenContextEnabled ? voiceScreenContextRef.current : "",
            },
          });
          const audioUrl = responseToAudioUrl(response);
          appendVoiceResponseLog(response, audioUrl);
          setVoiceStatusText(`识别完成：${response.transcript}`);
          playVoiceAudio(audioUrl);
        }
      } catch (error) {
        setVoiceStatusText(`语音对话失败：${stringifyError(error)}`);
      } finally {
        voiceTurnProcessingRef.current = false;
        setVoiceBusy(false);
      }
    },
    [appendVoiceResponseLog, playVoiceAudio, responseToAudioUrl, voiceConfig, voiceScreenContextEnabled],
  );

  const enqueueVoiceTurn = useCallback(
    (blob: Blob) => {
      if (voiceTurnQueueRef.current.length >= MAX_VOICE_TURN_QUEUE) {
        voiceTurnQueueRef.current.splice(0, voiceTurnQueueRef.current.length - MAX_VOICE_TURN_QUEUE + 1);
      }
      voiceTurnQueueRef.current.push(blob);
      if (voiceTurnQueueRef.current.length > 1 || voiceTurnProcessingRef.current) {
        setVoiceStatusText(`已加入语音处理队列：${voiceTurnQueueRef.current.length} 段。`);
      }
      void processVoiceTurnQueue();
    },
    [processVoiceTurnQueue],
  );

  const processLiveDanmakuQueue = useCallback(
    async () => {
      if (liveDanmakuProcessingRef.current) {
        return;
      }
      liveDanmakuProcessingRef.current = true;
      setVoiceBusy(true);
      try {
        while (liveDanmakuQueueRef.current.length > 0) {
          const item = liveDanmakuQueueRef.current.shift();
          if (!item) {
            break;
          }
          const cooldownMs = Math.max(0, voiceConfig.liveDanmakuCooldownSeconds || 0) * 1000;
          const now = Date.now();
          const waitMs = Math.max(0, liveDanmakuLastReplyAtRef.current + cooldownMs - now);
          if (waitMs > 0) {
            setVoiceStatusText(`直播弹幕语音回复冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒...`);
            await new Promise((resolve) => window.setTimeout(resolve, waitMs));
          }

          setVoiceStatusText(`正在回应直播弹幕：${item.nickname}：${item.text}`);
          const response = await invoke<VoiceChatResponse>("voice_text_turn", {
            request: {
              text: item.text,
              sourceLabel: `B站直播弹幕 ${item.nickname}`,
              config: voiceConfig,
              screenContext: voiceScreenContextEnabled ? voiceScreenContextRef.current : "",
            },
          });
          const audioUrl = responseToAudioUrl(response);
          appendVoiceResponseLog(response, audioUrl);
          liveDanmakuLastReplyAtRef.current = Date.now();
          setVoiceStatusText(`已回应直播弹幕：${item.nickname}`);
          playVoiceAudio(audioUrl);
        }
      } catch (error) {
        setVoiceStatusText(`直播弹幕语音回复失败：${stringifyError(error)}`);
      } finally {
        liveDanmakuProcessingRef.current = false;
        setVoiceBusy(false);
      }
    },
    [appendVoiceResponseLog, playVoiceAudio, responseToAudioUrl, voiceConfig, voiceScreenContextEnabled],
  );

  const enqueueLiveDanmaku = useCallback(
    (item: { id: string; nickname: string; text: string }) => {
      if (!voiceConfig.liveDanmakuReplyEnabled) {
        return;
      }
      if (liveDanmakuQueueRef.current.length >= MAX_LIVE_DANMAKU_VOICE_QUEUE) {
        liveDanmakuQueueRef.current.splice(
          0,
          liveDanmakuQueueRef.current.length - MAX_LIVE_DANMAKU_VOICE_QUEUE + 1,
        );
      }
      liveDanmakuQueueRef.current.push(item);
      if (liveDanmakuQueueRef.current.length > 1 || liveDanmakuProcessingRef.current) {
        setVoiceStatusText(`直播弹幕已加入语音回复队列：${liveDanmakuQueueRef.current.length} 条。`);
      }
      void processLiveDanmakuQueue();
    },
    [processLiveDanmakuQueue, voiceConfig.liveDanmakuReplyEnabled],
  );

  const processGameEventQueue = useCallback(
    async () => {
      if (gameEventProcessingRef.current) {
        return;
      }
      gameEventProcessingRef.current = true;
      setVoiceBusy(true);
      try {
        while (gameEventQueueRef.current.length > 0) {
          const item = gameEventQueueRef.current.shift();
          setLatestGameEventVoiceLine(
            gameEventQueueRef.current[gameEventQueueRef.current.length - 1]?.eventText ?? "暂无待处理事件",
          );
          if (!item) {
            break;
          }
          const cooldownMs = Math.max(0, voiceConfig.gameEventVoiceCooldownSeconds || 0) * 1000;
          const now = Date.now();
          const waitMs = Math.max(0, gameEventLastReplyAtRef.current + cooldownMs - now);
          if (waitMs > 0) {
            setVoiceStatusText(`游戏事件语音回复冷却中，等待 ${Math.ceil(waitMs / 1000)} 秒...`);
            await new Promise((resolve) => window.setTimeout(resolve, waitMs));
          }

          setVoiceStatusText(`正在回应 Minecraft 事件：${item.eventText}`);
          const response = await invoke<VoiceChatResponse>("voice_text_turn", {
            request: {
              text: `请用一句很短、自然、带一点你本人语气的话回应这个 Minecraft 游戏事件，不要复述日志格式：${item.eventText}`,
              sourceLabel: "Minecraft游戏事件",
              config: voiceConfig,
              screenContext: voiceScreenContextEnabled ? voiceScreenContextRef.current : "",
            },
          });
          const audioUrl = responseToAudioUrl(response);
          appendVoiceResponseLog(response, audioUrl);
          gameEventLastReplyAtRef.current = Date.now();
          setVoiceStatusText(`已回应 Minecraft 事件：${item.eventText}`);
          playVoiceAudio(audioUrl);
        }
      } catch (error) {
        setVoiceStatusText(`游戏事件语音回复失败：${stringifyError(error)}`);
      } finally {
        gameEventProcessingRef.current = false;
        setVoiceBusy(false);
      }
    },
    [appendVoiceResponseLog, playVoiceAudio, responseToAudioUrl, voiceConfig, voiceScreenContextEnabled],
  );

  const enqueueGameEvent = useCallback(
    (item: { id: string; eventText: string }) => {
      if (!voiceConfig.gameEventVoiceEnabled) {
        return;
      }
      if (gameEventQueueRef.current.length >= MAX_GAME_EVENT_VOICE_QUEUE) {
        gameEventQueueRef.current.splice(
          0,
          gameEventQueueRef.current.length - MAX_GAME_EVENT_VOICE_QUEUE + 1,
        );
      }
      gameEventQueueRef.current.push(item);
      setLatestGameEventVoiceLine(item.eventText);
      if (gameEventQueueRef.current.length > 1 || gameEventProcessingRef.current) {
        setVoiceStatusText(`游戏事件已加入语音回复队列：${gameEventQueueRef.current.length} 条。`);
      }
      void processGameEventQueue();
    },
    [processGameEventQueue, voiceConfig.gameEventVoiceEnabled],
  );

  useEffect(() => {
    if (!voiceConfig.liveDanmakuReplyEnabled) {
      liveDanmakuPrimedRef.current = false;
      return;
    }
    const liveProcess = orderedProcesses.find((process) => process.id === "bilibili-live");
    if (!liveProcess?.logLines.length) {
      return;
    }

    for (const line of liveProcess.logLines.slice(-80)) {
      const match = line.match(DANMAKU_LOG_PATTERN);
      if (!match) {
        continue;
      }
      const nickname = match[1]?.trim() ?? "观众";
      const text = match[3]?.trim() ?? "";
      if (!text) {
        continue;
      }
      const id = line;
      if (liveDanmakuSeenRef.current.has(id)) {
        continue;
      }
      liveDanmakuSeenRef.current.add(id);
      if (liveDanmakuSeenRef.current.size > 400) {
        liveDanmakuSeenRef.current = new Set(Array.from(liveDanmakuSeenRef.current).slice(-240));
      }
      if (liveDanmakuPrimedRef.current) {
        enqueueLiveDanmaku({ id, nickname, text });
      }
    }
    liveDanmakuPrimedRef.current = true;
  }, [enqueueLiveDanmaku, orderedProcesses, voiceConfig.liveDanmakuReplyEnabled]);

  useEffect(() => {
    if (!voiceConfig.gameEventVoiceEnabled) {
      gameEventPrimedRef.current = false;
      return;
    }
    const currentGameProcess = orderedProcesses.find((process) => process.id === "maicraft-next");
    if (!currentGameProcess?.logLines.length) {
      return;
    }

    for (const line of currentGameProcess.logLines.slice(-100)) {
      const eventText = extractGameVoiceEvent(line);
      if (!eventText) {
        continue;
      }
      const id = `${line}`;
      if (gameEventSeenRef.current.has(id)) {
        continue;
      }
      gameEventSeenRef.current.add(id);
      if (gameEventSeenRef.current.size > 500) {
        gameEventSeenRef.current = new Set(Array.from(gameEventSeenRef.current).slice(-280));
      }
      if (gameEventPrimedRef.current) {
        enqueueGameEvent({ id, eventText });
      }
    }
    gameEventPrimedRef.current = true;
  }, [enqueueGameEvent, orderedProcesses, voiceConfig.gameEventVoiceEnabled]);

  useEffect(() => {
    if (!voiceConfig.gameEventVoiceEnabled) {
      gameEventQueueRef.current = [];
    }
  }, [voiceConfig.gameEventVoiceEnabled]);

  const stopVoiceRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, []);

  const getPreferredVoiceMimeType = useCallback(() => {
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return "audio/webm;codecs=opus";
    }
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return "audio/webm";
    }
    return "";
  }, []);

  const startVoiceRecording = useCallback(async () => {
    if (voiceBusy || voiceRecording) {
      return;
    }

    setVoiceStatusText("正在请求麦克风权限...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints());
      const mimeType = getPreferredVoiceMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const chunks = recordingChunksRef.current;
        const recordedType = recorder.mimeType || mimeType || "audio/webm";
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setVoiceRecording(false);

        if (chunks.length === 0) {
          setVoiceStatusText("没有录到音频，请重新录制。");
          return;
        }

        const blob = new Blob(chunks, { type: recordedType });
        enqueueVoiceTurn(blob);
      };

      recorder.start();
      setVoiceRecording(true);
      setVoiceStatusText("正在录音，讲完后点“停止并发送”。");
    } catch (error) {
      setVoiceRecording(false);
      setVoiceStatusText(`无法开始录音：${stringifyError(error)}`);
    }
  }, [enqueueVoiceTurn, getPreferredVoiceMimeType, getVoiceAudioConstraints, voiceBusy, voiceRecording]);

  const finishAlwaysOnRecording = useCallback(() => {
    const recorder = alwaysOnRecorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      return;
    }
    recorder.stop();
  }, []);

  const startAlwaysOnClip = useCallback(() => {
    const stream = alwaysOnStreamRef.current;
    if (!stream || alwaysOnRecorderRef.current) {
      return;
    }
    const mimeType = getPreferredVoiceMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    alwaysOnChunksRef.current = [];
    alwaysOnRecordedTypeRef.current = recorder.mimeType || mimeType || "audio/webm";
    alwaysOnRecorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        alwaysOnChunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const chunks = alwaysOnChunksRef.current;
      if (alwaysOnSegmentTimerRef.current !== null) {
        window.clearTimeout(alwaysOnSegmentTimerRef.current);
        alwaysOnSegmentTimerRef.current = null;
      }
      alwaysOnRecorderRef.current = null;
      alwaysOnChunksRef.current = [];
      alwaysOnSpeakingRef.current = false;
      if (!voiceAlwaysOnRef.current || chunks.length === 0) {
        return;
      }
      const blob = new Blob(chunks, { type: alwaysOnRecordedTypeRef.current });
      if (blob.size < 1600) {
        setVoiceStatusText("常开监听中，忽略过短音频。");
        return;
      }
      enqueueVoiceTurn(blob);
    };
    recorder.start();
    if (alwaysOnSegmentTimerRef.current !== null) {
      window.clearTimeout(alwaysOnSegmentTimerRef.current);
    }
    alwaysOnSegmentTimerRef.current = window.setTimeout(() => {
      finishAlwaysOnRecording();
    }, 4200);
    alwaysOnSpeakingRef.current = true;
    alwaysOnLastVoiceAtRef.current = performance.now();
    setVoiceStatusText("检测到说话，正在录音...");
  }, [enqueueVoiceTurn, finishAlwaysOnRecording, getPreferredVoiceMimeType]);

  const startAlwaysOnVoice = useCallback(async () => {
    if (voiceAlwaysOnRef.current) {
      return;
    }
    if (voiceRecording) {
      stopVoiceRecording();
    }

    setVoiceStatusText("正在开启常开语音对话...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia(getVoiceAudioConstraints());
      const AudioContextClass =
        window.AudioContext ||
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("当前 WebView 不支持 AudioContext。");
      }
      const audioContext = new AudioContextClass();
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      alwaysOnStreamRef.current = stream;
      alwaysOnAudioContextRef.current = audioContext;
      alwaysOnAnalyserRef.current = analyser;
      setVoiceAlwaysOn(true);
      voiceAlwaysOnRef.current = true;
      setVoiceStatusText("常开语音对话已开启，直接说话即可。");

      const samples = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!voiceAlwaysOnRef.current) {
          return;
        }
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const centered = sample - 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / samples.length) / 128;
        const now = performance.now();
        const isVoice = rms > 0.055;
        if (now >= alwaysOnCooldownUntilRef.current) {
          if (isVoice && !alwaysOnSpeakingRef.current) {
            startAlwaysOnClip();
          }
          if (isVoice && alwaysOnSpeakingRef.current) {
            alwaysOnLastVoiceAtRef.current = now;
          }
          if (alwaysOnSpeakingRef.current && now - alwaysOnLastVoiceAtRef.current > 650) {
            finishAlwaysOnRecording();
          }
          if (
            !alwaysOnSpeakingRef.current &&
            !alwaysOnRecorderRef.current &&
            !voicePlaybackActiveRef.current &&
            voicePlaybackQueueRef.current.length > 0
          ) {
            const nextAudioUrl = voicePlaybackQueueRef.current.shift();
            if (nextAudioUrl) {
              playVoiceAudio(nextAudioUrl);
            }
          }
        }
      };
      alwaysOnAnimationRef.current = window.setInterval(tick, 90);
    } catch (error) {
      stopAlwaysOnVoice();
      setVoiceStatusText(`无法开启常开语音：${stringifyError(error)}`);
    }
  }, [
    finishAlwaysOnRecording,
    getVoiceAudioConstraints,
    playVoiceAudio,
    startAlwaysOnClip,
    stopAlwaysOnVoice,
    stopVoiceRecording,
    voiceRecording,
  ]);

  const toggleAlwaysOnVoice = useCallback(() => {
    if (voiceAlwaysOnRef.current) {
      stopAlwaysOnVoice();
    } else {
      void startAlwaysOnVoice();
    }
  }, [startAlwaysOnVoice, stopAlwaysOnVoice]);

  useEffect(() => {
    voiceLogsRef.current = voiceLogs;
  }, [voiceLogs]);

  useEffect(() => {
    return () => {
      mediaRecorderRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (alwaysOnAnimationRef.current !== null) {
        window.clearInterval(alwaysOnAnimationRef.current);
      }
      if (alwaysOnSegmentTimerRef.current !== null) {
        window.clearTimeout(alwaysOnSegmentTimerRef.current);
      }
      alwaysOnStreamRef.current?.getTracks().forEach((track) => track.stop());
      void alwaysOnAudioContextRef.current?.close().catch(() => undefined);
      voiceLogsRef.current.forEach((item) => URL.revokeObjectURL(item.audioUrl));
    };
  }, []);

  useEffect(() => {
    if (!isTauriEnvironment()) {
      return;
    }

    let disposed = false;
    const timer = window.setTimeout(() => {
      void runProcessAction(
        "start_all_managed_processes",
        undefined,
        "正在自动拉起内置进程...",
        "内置进程已自动拉起。",
      ).catch(() => {
        if (!disposed) {
          setProcessStatusText("自动拉起内置进程失败，请切到进程面板查看详情。");
        }
      });
    }, 0);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [runProcessAction]);

  return (
    <main className="shell">
      {visibleOfflineAlerts.length > 0 ? (
        <aside className="offline-alert-stack" aria-live="assertive">
          {visibleOfflineAlerts.map((alert) => (
            <article className="offline-alert-card" key={alert.id}>
              <button
                aria-label="关闭提示"
                className="alert-close-button"
                type="button"
                onClick={() =>
                  setDismissedOfflineAlertIds((current) =>
                    current.includes(alert.id) ? current : [...current, alert.id],
                  )
                }
              >
                ×
              </button>
              <p className="offline-alert-kicker">掉线提醒</p>
              <h2>{alert.title}</h2>
              <p className="offline-alert-summary">{alert.summary}</p>
              <p className="offline-alert-detail">{alert.detail}</p>
              <div className="offline-alert-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => focusProcessLog(alert.processId, `已定位到 ${alert.title} 日志。`)}
                >
                  查看日志
                </button>
                <button
                  className="danger-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "prepare_stable_qq_login",
                      undefined,
                      "正在执行稳态重登准备：停止 NapCat/Adapter 并清理 QQ 登录链路残留...",
                      "稳态重登准备完成。请确认普通 QQ 没有登录 bot 号，再启动 Adapter 和 NapCat。",
                    )
                  }
                >
                  稳态重登
                </button>
                <button
                  className="secondary-button"
                  disabled={loginHelperBusy}
                  type="button"
                  onClick={() => void sendLoginHelperEmail()}
                >
                  发送登录邮件
                </button>
              </div>
            </article>
          ))}
        </aside>
      ) : null}

      <section className="masthead">
        <div className="masthead-copy">
          <p className="eyebrow">teabot</p>
          <h1>把 MaiBot 和 NapCat 收进一个桌面控制台</h1>
          <p className="lede">
            现在除了 WebUI，还能把 MaiBot 主程序、NapCat Adapter 和 NapCat
            的运行日志直接塞进软件里看，切换和排错都不用再盯外面的 cmd 窗口。
          </p>
        </div>
        <div className="masthead-panel">
          <span className="status-dot" />
          <p>
            {viewMode === "services"
              ? statusText
              : viewMode === "live"
                ? voiceStatusText
                : viewMode === "game"
                  ? gameServerStatusText
                  : viewMode === "voice"
                    ? voiceStatusText
                    : processStatusText}
          </p>
        </div>
      </section>

      <section className="view-switcher">
        <button
          className="view-button"
          type="button"
          title="切换主题：跟随系统 / 浅色 / 深色"
          onClick={() =>
            setThemePref((current) =>
              current === "system" ? "light" : current === "light" ? "dark" : "system",
            )
          }
        >
          {themePref === "system" ? "🖥 跟随系统" : themePref === "light" ? "☀ 浅色" : "🌙 深色"}
        </button>
        <button
          className={viewMode === "services" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("services")}
        >
          Web 控制台
        </button>
        <button
          className={viewMode === "processes" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={openProcessPanel}
        >
          进程面板
        </button>
        <button
          className={viewMode === "voice" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("voice")}
        >
          语音对话
        </button>
        <button
          className={viewMode === "live" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("live")}
        >
          直播模块
        </button>
        <button
          className={viewMode === "game" ? "view-button view-button--active" : "view-button"}
          type="button"
          onClick={() => setViewMode("game")}
        >
          游戏模块
        </button>
      </section>

      {viewMode === "services" ? (
        <>
          <section className="overview-grid">
            {resolvedServices.map((service) => {
              const selected = service.id === activeServiceId;
              return (
                <article
                  className={`service-card${selected ? " service-card--active" : ""}`}
                  key={service.id}
                >
                  <div className="service-header">
                    <div>
                      <p className="service-kicker">
                        {service.id === "maibot" ? "主控" : "连接层"}
                      </p>
                      <h2>{service.name}</h2>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setActiveServiceId(service.id)}
                    >
                      {selected ? "当前面板" : "切到这里"}
                    </button>
                  </div>

                  <p className="service-description">{service.description}</p>

                  <label className="field" htmlFor={`${service.id}-url`}>
                    <span>服务地址</span>
                    <input
                      id={`${service.id}-url`}
                      value={service.url}
                      onChange={(event) =>
                        setUrlDrafts((current) => ({
                          ...current,
                          [service.id]: event.target.value,
                        }))
                      }
                      placeholder={service.defaultUrl}
                    />
                  </label>

                  <div className="service-actions">
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => {
                        setActiveServiceId(service.id);
                        setOpenInFrame(true);
                        void openServiceWindow(service);
                      }}
                    >
                      软件内打开
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void openServiceExternally(service)}
                    >
                      浏览器打开
                    </button>
                  </div>

                  <p className="service-tip">{service.troubleshootingTip}</p>
                </article>
              );
            })}
          </section>

          <section className="workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">当前工作区</p>
                <h2>{activeService.name}</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className={openInFrame ? "tab-button tab-button--active" : "tab-button"}
                  type="button"
                  onClick={() => setOpenInFrame(true)}
                >
                  小窗模式
                </button>
                <button
                  className={!openInFrame ? "tab-button tab-button--active" : "tab-button"}
                  type="button"
                  onClick={() => setOpenInFrame(false)}
                >
                  故障页
                </button>
              </div>
            </div>

            {openInFrame ? (
              <section className="fallback-panel">
                <h3>软件内小窗模式</h3>
                <p>
                  登录页不再塞进主界面。现在会用软件内独立小窗打开 MaiBot / NapCat，
                  这样会话更接近正常浏览器，稳定性也更高。
                </p>
                <ul>
                  <li>当前地址：{activeService.effectiveUrl}</li>
                  <li>如果已经开过同一个服务的小窗，再点会直接唤起原窗口。</li>
                  <li>修改了地址后再打开，会自动重建该服务窗口。</li>
                </ul>
                <div className="workspace-actions">
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => void openServiceWindow(activeService)}
                  >
                    打开 {activeService.name} 小窗
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void openServiceExternally(activeService)}
                  >
                    改用系统浏览器
                  </button>
                </div>
              </section>
            ) : (
              <section className="fallback-panel">
                <h3>额外操作和故障修复建议</h3>
                <p>
                  某些页面可能因为登录态、跨域策略、外部跳转或独立弹窗而不适合长期嵌入。遇到这些情况，直接切浏览器处理更稳。
                </p>
                <ul>
                  <li>MaiBot：日志卡死、WebSocket 重连、插件页面异常时优先浏览器打开。</li>
                  <li>NapCat：扫码、重新登录、网络配置、Token 查看一般都建议浏览器里做。</li>
                  <li>后续会把这里接成检测服务状态、一键打开和一键重启的故障中心。</li>
                </ul>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void openServiceExternally(activeService)}
                >
                  现在打开 {activeService.name}
                </button>
              </section>
            )}
          </section>

          <section className="workspace login-helper-panel">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">登录助手</p>
                <h2>远程登录入口和邮件推送</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary-button"
                  disabled={loginHelperBusy}
                  type="button"
                  onClick={() => void refreshLoginHelperStatus()}
                >
                  刷新登录信息
                </button>
                <button
                  className="primary-button"
                  disabled={loginHelperBusy}
                  type="button"
                  onClick={() => void sendLoginHelperEmail()}
                >
                  发送登录邮件
                </button>
              </div>
            </div>

            <p className="service-description">
              这里会分别读取 MaiBot WebUI 的 Access Token 和 NapCat WebUI 的 Token。
              它只负责把入口发给你，不能绕过 QQ 的扫码、手机确认或风控验证。
            </p>

            <div className="login-helper-grid">
              <article className="meta-card">
                <p className="service-kicker">MaiBot WebUI</p>
                <span className="state-pill">{loginHelperStatus?.maibotWebuiUrl ?? "未读取"}</span>
                <code>{loginHelperStatus?.maibotAccessToken || "Access Token 未读取"}</code>
                <div className="service-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void openExternal(loginHelperStatus?.maibotWebuiUrl || "http://127.0.0.1:8001")
                    }
                  >
                    浏览器打开 MaiBot
                  </button>
                </div>
              </article>

              <article className="meta-card">
                <p className="service-kicker">NapCat WebUI</p>
                <span className="state-pill">{loginHelperStatus?.napcatWebuiUrl ?? "未读取"}</span>
                <code>{loginHelperStatus?.napcatToken || "NapCat Token 未读取"}</code>
                <div className="service-actions">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      void openExternal(loginHelperStatus?.napcatWebuiUrl || "http://127.0.0.1:6099/webui")
                    }
                  >
                    浏览器打开 NapCat
                  </button>
                </div>
              </article>

              <article className="meta-card">
                <p className="service-kicker">QQ 登录稳态</p>
                <span className={hasLoginStabilityRisk ? "state-pill state-pill--danger" : "state-pill state-pill--running"}>
                  {loginStabilityReport?.status ?? "未刷新"}
                </span>
                <p className="meta-note">
                  Bot QQ：{loginHelperStatus?.qqAccount ?? loginStabilityReport?.qqAccount ?? "未读取"}；
                  邮件配置：{loginHelperStatus?.mailConfigured ? "完整" : "未完整配置"}。
                </p>
                <div className="service-actions">
                  <button
                    className="secondary-button secondary-button--warning"
                    disabled={processBusy !== null}
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "prepare_stable_qq_login",
                        undefined,
                        "正在执行稳态重登准备：停止 NapCat/Adapter 并清理 QQ 登录链路残留...",
                        "稳态重登准备完成。请确认普通 QQ 没有登录 bot 号，再启动 Adapter 和 NapCat。",
                      )
                    }
                  >
                    稳态重登准备
                  </button>
                </div>
              </article>
            </div>

            <div className="login-helper-form">
              <label className="field" htmlFor="login-helper-recipient">
                <span>收件邮箱</span>
                <input
                  id="login-helper-recipient"
                  value={loginHelperConfig.recipientEmail}
                  onChange={(event) => updateLoginHelperConfig("recipientEmail", event.target.value)}
                  placeholder="2418749618@qq.com"
                />
              </label>
              <label className="field" htmlFor="login-helper-smtp-host">
                <span>SMTP 主机</span>
                <input
                  id="login-helper-smtp-host"
                  value={loginHelperConfig.smtpHost}
                  onChange={(event) => updateLoginHelperConfig("smtpHost", event.target.value)}
                  placeholder="例如 smtp.qq.com"
                />
              </label>
              <label className="field" htmlFor="login-helper-smtp-port">
                <span>SMTP 端口</span>
                <input
                  id="login-helper-smtp-port"
                  min={1}
                  type="number"
                  value={loginHelperConfig.smtpPort}
                  onChange={(event) =>
                    updateLoginHelperConfig("smtpPort", Number(event.target.value) || 587)
                  }
                />
              </label>
              <label className="field" htmlFor="login-helper-smtp-user">
                <span>SMTP 账号</span>
                <input
                  id="login-helper-smtp-user"
                  value={loginHelperConfig.smtpUsername}
                  onChange={(event) => updateLoginHelperConfig("smtpUsername", event.target.value)}
                  placeholder="通常是发件邮箱"
                />
              </label>
              <label className="field" htmlFor="login-helper-smtp-from">
                <span>发件人</span>
                <input
                  id="login-helper-smtp-from"
                  value={loginHelperConfig.smtpFrom}
                  onChange={(event) => updateLoginHelperConfig("smtpFrom", event.target.value)}
                  placeholder="留空保存时会使用 SMTP 账号"
                />
              </label>
              <label className="field" htmlFor="login-helper-smtp-password">
                <span>SMTP 授权码 / 密码</span>
                <input
                  id="login-helper-smtp-password"
                  type="password"
                  value={loginHelperConfig.smtpPassword}
                  onChange={(event) => updateLoginHelperConfig("smtpPassword", event.target.value)}
                  placeholder="邮箱后台生成的 SMTP 授权码"
                />
              </label>
            </div>

            <label className="forge-mode-toggle">
              <input
                checked={loginHelperConfig.smtpUseSsl}
                type="checkbox"
                onChange={(event) => updateLoginHelperConfig("smtpUseSsl", event.target.checked)}
              />
              <span>
                <strong>启用 SMTP SSL/TLS</strong>
                <small>
                  QQ 邮箱建议使用 smtp.qq.com、端口 587，并需要邮箱设置里的 SMTP 授权码。配置会保存在本机桌面端配置文件里。
                </small>
              </span>
            </label>

            <div className="workspace-actions">
              <button
                className="secondary-button"
                disabled={loginHelperBusy}
                type="button"
                onClick={() => void saveLoginHelperConfig()}
              >
                保存邮件配置
              </button>
              <button
                className="primary-button"
                disabled={loginHelperBusy}
                type="button"
                onClick={() => void sendLoginHelperEmail()}
              >
                保存并发送测试邮件
              </button>
            </div>
            <p className="service-tip">{loginHelperStatusText}</p>
          </section>
        </>
      ) : viewMode === "live" ? (
        <>
          <section className="module-hero-grid">
            <article className="service-card voice-status-card">
              <p className="service-kicker">Bilibili Live</p>
              <h2>直播模块</h2>
              <p className="service-description">
                这里专门管理 B 站直播间弹幕监听和语音回复。弹幕回复会复用当前语音配置里的回复模型和伊蕾娜语音，
                不会把弹幕转进 QQ 聊天链路。
              </p>
              <div className="module-status-grid">
                <article className="meta-card">
                  <p className="service-kicker">监听进程</p>
                  <span className={liveProcess?.running ? "state-pill state-pill--running" : "state-pill"}>
                    {liveProcess ? getProcessStateLabel(liveProcess) : "未加载"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">弹幕语音</p>
                  <span
                    className={
                      voiceConfig.liveDanmakuReplyEnabled
                        ? "state-pill state-pill--running"
                        : "state-pill"
                    }
                  >
                    {voiceConfig.liveDanmakuReplyEnabled ? "已开启" : "已关闭"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">房间号</p>
                  <code>{voiceConfig.bilibiliRoomId.trim() || "未设置"}</code>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">语音 API</p>
                  <span className={ttsProcess?.running ? "state-pill state-pill--running" : "state-pill"}>
                    {ttsProcess ? getProcessStateLabel(ttsProcess) : "未加载"}
                  </span>
                </article>
              </div>
              {liveProcess?.issue || liveProcess?.statusNote ? (
                <div className="process-issue-banner">
                  {liveProcess.issue ?? liveProcess.statusNote}
                </div>
              ) : null}
            </article>

            <article className="service-card">
              <p className="service-kicker">Live Settings</p>
              <h2>直播配置</h2>
              <label className="field" htmlFor="live-bilibili-room">
                <span>B站房间号</span>
                <input
                  id="live-bilibili-room"
                  inputMode="numeric"
                  value={voiceConfig.bilibiliRoomId}
                  onChange={(event) => updateVoiceConfig("bilibiliRoomId", event.target.value)}
                  placeholder="例如 123456"
                />
              </label>
              <div className="voice-config-grid">
                <label className="field" htmlFor="live-cooldown">
                  <span>弹幕回复冷却秒数</span>
                  <input
                    id="live-cooldown"
                    min={0}
                    max={600}
                    type="number"
                    value={voiceConfig.liveDanmakuCooldownSeconds}
                    onChange={(event) =>
                      updateVoiceConfig(
                        "liveDanmakuCooldownSeconds",
                        Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                      )
                    }
                  />
                </label>
                <button
                  className={voiceConfig.liveDanmakuReplyEnabled ? "secondary-button" : "ghost-button"}
                  type="button"
                  onClick={() =>
                    updateVoiceConfig("liveDanmakuReplyEnabled", !voiceConfig.liveDanmakuReplyEnabled)
                  }
                >
                  {voiceConfig.liveDanmakuReplyEnabled ? "弹幕语音回复：开" : "弹幕语音回复：关"}
                </button>
              </div>
              <div className="service-actions">
                <button
                  className="primary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={async () => {
                    await persistVoiceConfig({
                      ...voiceConfig,
                      liveDanmakuReplyEnabled: true,
                    });
                    liveDanmakuSeenRef.current.clear();
                    liveDanmakuPrimedRef.current = false;
                    await runProcessAction(
                      "start_managed_process",
                      { processId: "bilibili-live" },
                      "正在启动 B站直播弹幕监听...",
                      "B站直播弹幕监听启动请求已发送。",
                    );
                  }}
                >
                  保存并启动监听
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() => void saveVoiceConfig()}
                >
                  只保存配置
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_managed_process",
                      { processId: "bilibili-live" },
                      "正在停止 B站直播弹幕监听...",
                      "B站直播弹幕监听停止请求已发送。",
                    )
                  }
                >
                  停止监听
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openModuleLog("bilibili-live", "已切到直播监听日志。")}
                >
                  查看直播日志
                </button>
              </div>
            </article>
          </section>

          <section className="workspace voice-workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">Live Voice Timeline</p>
                <h2>直播语音回复记录</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "start_managed_process",
                      { processId: "tts-api" },
                      "正在启动 GPT-SoVITS 语音 API ...",
                      "GPT-SoVITS 语音 API 启动请求已发送。",
                    )
                  }
                >
                  启动伊蕾娜语音API
                </button>
              </div>
            </div>
            <p className="service-tip">
              当前语音状态：{voiceStatusText}。如果直播弹幕没有出声，先确认直播监听和语音 API 都在运行。
            </p>
          </section>
        </>
      ) : viewMode === "game" ? (
        <>
          <section className="module-hero-grid">
            <article className="service-card voice-status-card">
              <p className="service-kicker">Maicraft Next</p>
              <h2>游戏模块</h2>
              <p className="service-description">
                原版、Paper、Spigot、Purpur 或兼容原版协议的服可以直接用轻量协议 Bot；1.20.1 Forge 服可以尝试开启现代 Forge/FML3 实验兼容，不行再切 Forge 真客户端控制。
                Forge 控制AI会控制另开的真实客户端里的 bot 身体，不会再抢你自己 PCL2 窗口的键鼠。
              </p>
              <div className="module-status-grid">
                <article className="meta-card">
                  <p className="service-kicker">游戏进程</p>
                  <span className={gameProcess?.running ? "state-pill state-pill--running" : "state-pill"}>
                    {gameProcess ? getProcessStateLabel(gameProcess) : "未加载"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">Forge 真客户端</p>
                  <span className={forgeClientProcess?.running ? "state-pill state-pill--running" : "state-pill"}>
                    {forgeClientProcess ? getProcessStateLabel(forgeClientProcess) : "未加载"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">Forge 桥接</p>
                  <span className={forgeBridgeStatus?.connected ? "state-pill state-pill--running" : "state-pill"}>
                    {forgeBridgeStatus?.connected ? "可控制" : "未连接"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">Forge 控制AI</p>
                  <span className={forgeAgentProcess?.running ? "state-pill state-pill--running" : "state-pill"}>
                    {forgeAgentProcess ? getProcessStateLabel(forgeAgentProcess) : "未加载"}
                  </span>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">WebSocket</p>
                  <code>25114</code>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">Minecraft</p>
                  <code>{maicraftEndpoint}</code>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">Bot 游戏名</p>
                  <code>{maicraftConfig.username || "MaicraftBot"}</code>
                </article>
                <article className="meta-card">
                  <p className="service-kicker">事件语音</p>
                  <span
                    className={voiceConfig.gameEventVoiceEnabled ? "state-pill state-pill--running" : "state-pill"}
                  >
                    {voiceConfig.gameEventVoiceEnabled ? "已开启" : "已关闭"}
                  </span>
                </article>
              </div>
              <div className={gameServerRefused || gameServerRequiresForge ? "cleanup-banner cleanup-banner--danger" : "cleanup-banner cleanup-banner--ok"}>
                {gameServerStatusText}
              </div>
              <p className="service-tip">
                游戏事件语音会监听 Maicraft 日志里的动作、战斗、死亡、重生和聊天事件，然后用当前语音配置合成一句短回应。
              </p>
              {gameProcess?.issue || gameProcess?.statusNote ? (
                <div className="process-issue-banner">
                  {gameProcess.issue ?? gameProcess.statusNote}
                </div>
              ) : null}
              {forgeClientProcess?.issue || forgeClientProcess?.statusNote ? (
                <div className="process-issue-banner">
                  {forgeClientProcess.issue ?? forgeClientProcess.statusNote}
                </div>
              ) : null}
              {forgeAgentProcess?.issue || forgeAgentProcess?.statusNote ? (
                <div className="process-issue-banner">
                  {forgeAgentProcess.issue ?? forgeAgentProcess.statusNote}
                </div>
              ) : null}
            </article>

            <article className="service-card">
              <p className="service-kicker">Game Control</p>
              <h2>连接配置</h2>
              <p className="service-description">
                如果要进朋友的服务器，填域名、端口和登录模式。离线服通常用 offline；正版验证服需要单独支持账号登录，
                不能绕过白名单、正版验证或反机器人限制。
              </p>
              <div className="voice-config-grid">
                <label className="field">
                  <span>服务器域名 / IP</span>
                  <input
                    value={maicraftConfig.host}
                    onChange={(event) => updateMaicraftConfig("host", event.target.value)}
                    placeholder="例如 mc.example.com"
                  />
                </label>
                <label className="field">
                  <span>服务器端口</span>
                  <input
                    min={1}
                    max={65535}
                    type="number"
                    value={maicraftConfig.port}
                    onChange={(event) => updateMaicraftConfig("port", Number(event.target.value))}
                  />
                </label>
                <label className="field">
                  <span>Bot 游戏名</span>
                  <input
                    value={maicraftConfig.username}
                    onChange={(event) => updateMaicraftConfig("username", event.target.value)}
                    placeholder="MaicraftBot"
                  />
                </label>
                <label className="field">
                  <span>Minecraft 版本</span>
                  <input
                    value={maicraftConfig.version}
                    onChange={(event) => updateMaicraftConfig("version", event.target.value)}
                    placeholder="例如 1.20.1，留空自动识别"
                  />
                </label>
                <label className="field">
                  <span>登录模式</span>
                  <select
                    className="voice-select"
                    value={maicraftConfig.auth}
                    onChange={(event) => updateMaicraftConfig("auth", event.target.value)}
                  >
                    <option value="offline">offline 离线服</option>
                    <option value="microsoft">microsoft 正版账号</option>
                    <option value="mojang">mojang 旧账号</option>
                  </select>
                </label>
              </div>
              <label className="forge-mode-toggle">
                <input
                  checked={maicraftConfig.forgeModern}
                  type="checkbox"
                  onChange={(event) => updateMaicraftConfig("forgeModern", event.target.checked)}
                />
                <span>
                  <strong>启用现代 Forge/FML3 协议实验兼容</strong>
                  <small>
                    打开后轻量协议 Bot 会模拟 Forge 1.20.1 登录握手，不额外启动游戏客户端。若服务器强校验客户端 mod，仍需要 Forge 真客户端。
                  </small>
                </span>
              </label>
              <label className="field">
                <span>协议 Bot 保活超时（毫秒）</span>
                <input
                  max={600000}
                  min={30000}
                  step={10000}
                  type="number"
                  value={maicraftConfig.keepAliveTimeout}
                  onChange={(event) => updateMaicraftConfig("keepAliveTimeout", Number(event.target.value))}
                />
              </label>
              <label className="field">
                <span>直接给 Bot 的游戏任务</span>
                <textarea
                  className="voice-textarea"
                  value={maicraftConfig.goal}
                  onChange={(event) => updateMaicraftConfig("goal", event.target.value)}
                  placeholder="例如：帮我挖一条矿道 / 帮我烧铁 / 搭一个小平台 / 采集一点木头"
                />
              </label>
              <label className="field">
                <span>Forge 真客户端目录</span>
                <input
                  type="text"
                  value={maicraftConfig.forgeClientPath}
                  onChange={(event) => updateMaicraftConfig("forgeClientPath", event.target.value)}
                  placeholder="例如：D:/mc/.minecraft/versions/1.20.1-Forge_47.4.20"
                />
              </label>
              <p className="service-tip">
                保存后如果 Forge 控制AI正在运行，它会自动读取新任务，不需要重启。下面的控制按钮主要用于调试桥接是否正常。
              </p>
              <div className="module-note">
                <strong>轻量协议 Bot：</strong>不启动第二个游戏客户端，负担最低，但它本质是 mineflayer/minecraft-protocol。
                它能进原版协议兼容服；开启上面的现代 Forge/FML3 实验兼容后，会尝试进入 1.20.1 Forge 服。
                如果服务器要求真实客户端 mod 逻辑或强校验整合包，仍请切到 Forge 真客户端。
              </div>
              <div className="module-note">
                <strong>Forge 真客户端：</strong>需要 Forge/FML 握手的服务器请用这个入口。它会启动
                <code>D:\mc\.minecraft\versions\1.20.1-Forge_47.4.20</code>，同步
                <code>E:\cha shi bot\mod</code> 里的 mod，然后直连当前服务器。启动后再开
                <strong>Forge 控制AI</strong>，它会通过本地桥接端口控制这个真实客户端移动和说话。
              </div>
              <div className="forge-bridge-panel">
                <div className="forge-bridge-panel__header">
                  <div>
                    <h3>Forge 真客户端调试控制</h3>
                    <p className="service-tip">
                      正常使用时直接在上面的任务框输入“帮我挖矿/烧东西/建平台”并保存。这里的按钮主要用于排查桥接动作是否能执行。
                    </p>
                  </div>
                  <div className="forge-bridge-header-actions">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setShowForgeDebugControls((value) => !value)}
                    >
                      {showForgeDebugControls ? "收起调试按钮" : "展开调试按钮"}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={forgeBridgeBusy}
                      type="button"
                      onClick={() => void refreshForgeBridgeStatus()}
                    >
                      刷新桥接状态
                    </button>
                  </div>
                </div>
                <div
                  className={
                    forgeBridgeStatus?.connected
                      ? "cleanup-banner cleanup-banner--ok"
                      : "cleanup-banner cleanup-banner--danger"
                  }
                >
                  {forgeBridgeStatusText}
                </div>
                {forgeBridgeStatus?.connected ? (
                  <div className="forge-bridge-stats">
                    <span>玩家：{forgeBridgeStatus.name ?? "未知"}</span>
                    <span>
                      坐标：
                      {typeof forgeBridgeStatus.x === "number" &&
                      typeof forgeBridgeStatus.y === "number" &&
                      typeof forgeBridgeStatus.z === "number"
                        ? `${forgeBridgeStatus.x.toFixed(1)}, ${forgeBridgeStatus.y.toFixed(1)}, ${forgeBridgeStatus.z.toFixed(1)}`
                        : "未知"}
                    </span>
                    <span>生命：{forgeBridgeStatus.health?.toFixed(1) ?? "未知"}</span>
                    <span>饥饿：{forgeBridgeStatus.food ?? "未知"}</span>
                    <span>维度：{forgeBridgeStatus.dimension ?? "未知"}</span>
                    <span>
                      YSM：
                      {forgeBridgeStatus.ysm?.installed
                        ? forgeBridgeStatus.ysm.screenOpen
                          ? "菜单已打开"
                          : "已加载"
                        : "未检测到"}
                    </span>
                    <span>
                      任务：
                      {forgeBridgeStatus.task?.mode && forgeBridgeStatus.task.mode !== "none"
                        ? `${forgeBridgeStatus.task.mode} / ${forgeBridgeStatus.task.status ?? "运行中"}`
                        : "空闲"}
                    </span>
                  </div>
                ) : null}
                {showForgeDebugControls ? (
                <div className="forge-bridge-controls">
                  <button
                    className="primary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.moveForward,
                        "正在让 Forge 客户端向前跑一小段...",
                        "已发送前进指令。",
                      )
                    }
                  >
                    前进一小段
                  </button>
                  <button
                    className="primary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void runForgeBridgePatrolTest()}
                  >
                    巡逻测试
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.moveLeft,
                        "正在让 Forge 客户端左移...",
                        "已发送左移指令。",
                      )
                    }
                  >
                    左移
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.moveRight,
                        "正在让 Forge 客户端右移...",
                        "已发送右移指令。",
                      )
                    }
                  >
                    右移
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.jump,
                        "正在让 Forge 客户端跳跃...",
                        "已发送跳跃指令。",
                      )
                    }
                  >
                    跳跃
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.attack,
                        "正在让 Forge 客户端攻击...",
                        "已发送攻击指令。",
                      )
                    }
                  >
                    攻击
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void scanForgeBridgeBlocks(FORGE_RESOURCE_SCAN_TARGETS, 10, 32)}
                  >
                    扫描资源
                  </button>
                  <button
                    className="primary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.mineWood,
                        "正在让 Forge 客户端采集最近木头...",
                        "已发送采集木头任务。",
                      )
                    }
                  >
                    采集最近木头
                  </button>
                  <button
                    className="primary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.mineStone,
                        "正在让 Forge 客户端采集最近石头...",
                        "已发送采集石头任务。",
                      )
                    }
                  >
                    采集最近石头
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.collectNearby,
                        "正在让 Forge 客户端收集附近掉落物...",
                        "已发送收集掉落物任务。",
                      )
                    }
                  >
                    收集掉落物
                  </button>
                  <button
                    className="primary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.mineTunnel,
                        "正在让 Forge 客户端挖一条 1x2 短矿道...",
                        "已发送挖矿道任务。",
                      )
                    }
                  >
                    挖短矿道
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.smeltNearby,
                        "正在尝试操作附近熔炉进行烧炼...",
                        "已发送烧炼任务。",
                      )
                    }
                  >
                    使用附近熔炉
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.buildPlatform,
                        "正在让 Forge 客户端搭一个 3x3 小平台...",
                        "已发送建平台任务。",
                      )
                    }
                  >
                    搭小平台
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.buildWall,
                        "正在让 Forge 客户端搭一面 3x2 小墙...",
                        "已发送建墙任务。",
                      )
                    }
                  >
                    搭小墙
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void openForgeBridgeYsmMenu()}
                  >
                    打开YSM模型菜单
                  </button>
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.ysmReload,
                        "正在重载 YSM 模型...",
                        "已发送 YSM 模型重载指令。",
                      )
                    }
                  >
                    重载YSM模型
                  </button>
                  <button
                    className="danger-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() =>
                      void runForgeBridgeCommand(
                        FORGE_DEBUG_COMMANDS.stop,
                        "正在停止 Forge 客户端按键...",
                        "已发送停止指令。",
                      )
                    }
                  >
                    立刻停止
                  </button>
                </div>
                ) : null}
                <div className="forge-bridge-chat">
                  <input
                    value={forgeBridgeYsmSearchDraft}
                    onChange={(event) => setForgeBridgeYsmSearchDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void openForgeBridgeYsmMenu();
                      }
                    }}
                    placeholder="YSM模型搜索词，可留空直接打开菜单"
                  />
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void openForgeBridgeYsmMenu()}
                  >
                    打开并搜索模型
                  </button>
                </div>
                <div className="forge-bridge-chat forge-bridge-chat--multi">
                  <input
                    value={forgeBridgeYsmModelDraft}
                    onChange={(event) => setForgeBridgeYsmModelDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void setForgeBridgeYsmModel();
                      }
                    }}
                    placeholder="YSM模型ID，例如 wine_fox_7_jk"
                  />
                  <input
                    value={forgeBridgeYsmTextureDraft}
                    onChange={(event) => setForgeBridgeYsmTextureDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void setForgeBridgeYsmModel();
                      }
                    }}
                    placeholder="贴图ID，默认 -"
                  />
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void setForgeBridgeYsmModel()}
                  >
                    切换YSM模型
                  </button>
                </div>
                <div className="forge-bridge-chat">
                  <input
                    value={forgeBridgeChatDraft}
                    onChange={(event) => setForgeBridgeChatDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        void sendForgeBridgeChat();
                      }
                    }}
                    placeholder="发送到 Minecraft 聊天"
                  />
                  <button
                    className="secondary-button"
                    disabled={forgeBridgeBusy}
                    type="button"
                    onClick={() => void sendForgeBridgeChat()}
                  >
                    发送游戏聊天
                  </button>
                </div>
                {forgeBridgeScan?.blocks?.length ? (
                  <div className="module-note">
                    <strong>最近扫描：</strong>
                    {forgeBridgeScan.blocks.slice(0, 6).map((block) => (
                      <span key={`${block.id}-${block.x}-${block.y}-${block.z}`}>
                        {" "}
                        {block.id}@{block.x},{block.y},{block.z}({block.distance.toFixed(1)})
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="game-voice-panel">
                <h3>游戏事件语音</h3>
                <p className="service-tip">
                  开启后，bot 会对自己在游戏里的行为和关键事件做语音回应。建议冷却不要低于 10 秒，不然移动/挖掘时会很吵。
                </p>
                <div className="voice-config-grid">
                  <label className="field">
                    <span>事件语音冷却秒数</span>
                    <input
                      min={3}
                      max={600}
                      type="number"
                      value={voiceConfig.gameEventVoiceCooldownSeconds}
                      onChange={(event) =>
                        updateVoiceConfig(
                          "gameEventVoiceCooldownSeconds",
                          Math.max(3, Number.parseInt(event.target.value, 10) || 18),
                        )
                      }
                    />
                  </label>
                  <button
                    className={voiceConfig.gameEventVoiceEnabled ? "secondary-button" : "ghost-button"}
                    type="button"
                    onClick={() => {
                      gameEventSeenRef.current.clear();
                      gameEventPrimedRef.current = false;
                      updateVoiceConfig("gameEventVoiceEnabled", !voiceConfig.gameEventVoiceEnabled);
                    }}
                  >
                    {voiceConfig.gameEventVoiceEnabled ? "游戏事件语音：开" : "游戏事件语音：关"}
                  </button>
                </div>
                <p className="service-tip">最近待处理事件：{latestGameEventVoiceLine}</p>
              </div>
              <p className="service-tip">{maicraftStatusText}</p>
              <div className="service-actions">
                <button
                  className="secondary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void saveVoiceConfig()}
                >
                  保存语音设置
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() => void persistMaicraftConfig(false)}
                >
                  保存配置
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null || Boolean(gameProcess?.running)}
                  type="button"
                  onClick={() => void persistMaicraftConfig(true)}
                >
                  启动轻量协议Bot（原版/插件服）
                </button>
                <button
                  className="primary-button"
                  disabled={processBusy !== null || Boolean(forgeClientProcess?.running)}
                  type="button"
                  onClick={async () => {
                    await persistMaicraftConfig(false);
                    await runProcessAction(
                      "start_managed_process",
                      { processId: "forge-client" },
                      "正在启动 Minecraft Forge 真客户端...",
                      "Minecraft Forge 真客户端启动请求已发送。",
                    );
                  }}
                >
                  保存并启动Forge真客户端
                </button>
                <button
                  className="primary-button"
                  disabled={processBusy !== null || Boolean(forgeAgentProcess?.running)}
                  type="button"
                  onClick={async () => {
                    await persistMaicraftConfig(false);
                    await runProcessAction(
                      "start_managed_process",
                      { processId: "forge-agent" },
                      "正在启动 Forge 控制AI...",
                      "Forge 控制AI启动请求已发送。它会等待真客户端桥接端口上线。",
                    );
                  }}
                >
                  启动Forge控制AI
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null || !gameProcess?.managedByApp}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_managed_process",
                      { processId: "maicraft-next" },
                      "正在停止 Maicraft Next 游戏Bot...",
                      "Maicraft Next 游戏Bot 停止请求已发送。",
                    )
                  }
                >
                  停止游戏Bot
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null || !forgeClientProcess?.managedByApp}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_managed_process",
                      { processId: "forge-client" },
                      "正在停止 Minecraft Forge 真客户端...",
                      "Minecraft Forge 真客户端停止请求已发送。",
                    )
                  }
                >
                  停止Forge真客户端
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null || !forgeAgentProcess?.managedByApp}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_managed_process",
                      { processId: "forge-agent" },
                      "正在停止 Forge 控制AI...",
                      "Forge 控制AI停止请求已发送。",
                    )
                  }
                >
                  停止Forge控制AI
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openModuleLog("maicraft-next", "已切到 Maicraft Next 日志。")}
                >
                  查看游戏日志
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openModuleLog("forge-client", "已切到 Forge 真客户端日志。")}
                >
                  查看Forge日志
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => openModuleLog("forge-agent", "已切到 Forge 控制AI日志。")}
                >
                  查看控制AI日志
                </button>
              </div>
              <div className="module-note">
                <strong>当前判断：</strong>项目可以运行到连接 Minecraft 的阶段；桌面端会用 DeepSeek 直连的“ds没脑子但是跑得快”
                给游戏模块做决策。Forge 整合包服不要点“轻量协议Bot”，请点“Forge真客户端”并启动“Forge控制AI”；上游 `npm run build`
                仍有 TypeScript 类型错误，所以这里用 `tsx` 运行入口。
              </div>
            </article>
          </section>
        </>
      ) : viewMode === "voice" ? (
        <>
          <section className="voice-hero-grid">
            <article className="service-card voice-status-card">
              <p className="service-kicker">Voice Chat</p>
              <h2>桌面端语音对话</h2>
              <p className="service-description">
                录音会在后端转成 16k 单声道 PCM，交给豆包语音识别；回复会读取当前 MaiBot
                人设和回复模型，再用本地伊蕾娜 GPT-SoVITS 合成语音。
              </p>
              <div className="voice-record-ring">
                <span
                  className={
                    voiceRecording || voiceAlwaysOn ? "voice-pulse voice-pulse--recording" : "voice-pulse"
                  }
                />
                <strong>
                  {voiceRecording ? "正在录音" : voiceBusy ? "处理中" : voiceAlwaysOn ? "常开监听" : "待机"}
                </strong>
              </div>
              <div className="service-actions">
                <button
                  className={voiceRecording ? "danger-button" : "primary-button"}
                  disabled={voiceAlwaysOn || (voiceBusy && !voiceRecording)}
                  type="button"
                  onClick={() =>
                    voiceRecording ? stopVoiceRecording() : void startVoiceRecording()
                  }
                >
                  {voiceRecording ? "停止并发送" : "开始录音"}
                </button>
                <button
                  className={voiceAlwaysOn ? "danger-button" : "secondary-button"}
                  disabled={voiceBusy && !voiceAlwaysOn}
                  type="button"
                  onClick={toggleAlwaysOnVoice}
                >
                  {voiceAlwaysOn ? "关闭常开语音" : "开启常开语音"}
                </button>
                <button
                  className={voiceScreenContextEnabled ? "secondary-button" : "ghost-button"}
                  type="button"
                  onClick={() => setVoiceScreenContextEnabled((current) => !current)}
                >
                  {voiceScreenContextEnabled ? "屏幕上下文：开" : "屏幕上下文：关"}
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "start_managed_process",
                      { processId: "tts-api" },
                      "正在启动 GPT-SoVITS 语音 API ...",
                      "GPT-SoVITS 语音 API 启动请求已发送。",
                    )
                  }
                >
                  启动伊蕾娜语音API
                </button>
              </div>
              <p className="service-tip">{voiceStatusText}</p>
              {voiceAlwaysOn && voiceScreenContextEnabled ? (
                <p className="voice-context-note">{voiceScreenContext}</p>
              ) : null}
            </article>

            <article className="service-card">
              <p className="service-kicker">Settings</p>
              <h2>语音配置</h2>
              <div className="voice-config-grid">
                <label className="field" htmlFor="voice-volc-app-id">
                  <span>火山 ASR APP ID</span>
                  <input
                    id="voice-volc-app-id"
                    value={voiceConfig.volcAsrAppId}
                    onChange={(event) => updateVoiceConfig("volcAsrAppId", event.target.value)}
                    placeholder="5029855949"
                  />
                </label>
                <label className="field" htmlFor="voice-volc-api-key">
                  <span>火山 ASR x-api-key</span>
                  <input
                    id="voice-volc-api-key"
                    type="password"
                    value={voiceConfig.volcAsrApiKey}
                    onChange={(event) => updateVoiceConfig("volcAsrApiKey", event.target.value)}
                    placeholder="662d8a47-..."
                  />
                </label>
                <label className="field" htmlFor="voice-volc-token">
                  <span>火山 Access Token 备用</span>
                  <input
                    id="voice-volc-token"
                    type="password"
                    value={voiceConfig.volcAsrAccessToken}
                    onChange={(event) => updateVoiceConfig("volcAsrAccessToken", event.target.value)}
                    placeholder="N9..."
                  />
                </label>
                <label className="field" htmlFor="voice-volc-submit">
                  <span>火山 Submit URL</span>
                  <input
                    id="voice-volc-submit"
                    value={voiceConfig.volcAsrSubmitUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrSubmitUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-query">
                  <span>火山 Query URL</span>
                  <input
                    id="voice-volc-query"
                    value={voiceConfig.volcAsrQueryUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrQueryUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-url">
                  <span>火山 Flash URL 备用</span>
                  <input
                    id="voice-volc-url"
                    value={voiceConfig.volcAsrUrl}
                    onChange={(event) => updateVoiceConfig("volcAsrUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-resource">
                  <span>火山资源 ID</span>
                  <input
                    id="voice-volc-resource"
                    value={voiceConfig.volcAsrResourceId}
                    onChange={(event) => updateVoiceConfig("volcAsrResourceId", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-model">
                  <span>火山 ASR 模型</span>
                  <input
                    id="voice-volc-model"
                    value={voiceConfig.volcAsrModel}
                    onChange={(event) => updateVoiceConfig("volcAsrModel", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-volc-secret">
                  <span>火山 Secret Key</span>
                  <input
                    id="voice-volc-secret"
                    type="password"
                    value={voiceConfig.volcAsrSecretKey}
                    onChange={(event) => updateVoiceConfig("volcAsrSecretKey", event.target.value)}
                    placeholder="已保存备用，极速版通常不用"
                  />
                </label>
                <label className="field" htmlFor="voice-asr-key">
                  <span>Ark ASR API Key 备用</span>
                  <input
                    id="voice-asr-key"
                    type="password"
                    value={voiceConfig.asrApiKey}
                    onChange={(event) => updateVoiceConfig("asrApiKey", event.target.value)}
                    placeholder="ark-..."
                  />
                </label>
                <label className="field" htmlFor="voice-asr-base">
                  <span>Ark ASR Base URL 备用</span>
                  <input
                    id="voice-asr-base"
                    value={voiceConfig.asrBaseUrl}
                    onChange={(event) => updateVoiceConfig("asrBaseUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-asr-model">
                  <span>Ark ASR 模型备用</span>
                  <input
                    id="voice-asr-model"
                    value={voiceConfig.asrModel}
                    onChange={(event) => updateVoiceConfig("asrModel", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-asr-path">
                  <span>Ark ASR 转写路径备用</span>
                  <input
                    id="voice-asr-path"
                    value={voiceConfig.asrTranscriptionPath}
                    onChange={(event) => updateVoiceConfig("asrTranscriptionPath", event.target.value)}
                    placeholder="/audio/transcriptions"
                  />
                </label>
                <label className="field" htmlFor="voice-output-language">
                  <span>默认输出语言</span>
                  <select
                    className="voice-select"
                    id="voice-output-language"
                    value={voiceConfig.outputLanguage}
                    onChange={(event) => updateVoiceConfig("outputLanguage", event.target.value)}
                  >
                    <option value="zh">中文</option>
                    <option value="ja">日语</option>
                    <option value="en">英语</option>
                  </select>
                </label>
                <label className="field" htmlFor="voice-input-device">
                  <span>语音监听输入设备</span>
                  <select
                    className="voice-select"
                    id="voice-input-device"
                    value={voiceConfig.inputDeviceId}
                    onChange={(event) => updateVoiceConfig("inputDeviceId", event.target.value)}
                  >
                    <option value="">系统默认麦克风</option>
                    {audioInputDevices.map((device, index) => (
                      <option key={`${device.deviceId}-${index}`} value={device.deviceId}>
                        {device.label || `音频输入设备 ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" htmlFor="voice-input-device-pattern">
                  <span>自动匹配输入设备名</span>
                  <input
                    id="voice-input-device-pattern"
                    value={voiceConfig.inputDeviceLabelPattern}
                    onChange={(event) => {
                      updateVoiceConfig("inputDeviceId", "");
                      updateVoiceConfig("inputDeviceLabelPattern", event.target.value);
                    }}
                    placeholder="例如 VoiceMeeter AUX Output"
                  />
                </label>
                <label className="field" htmlFor="voice-output-device">
                  <span>语音播放输出设备</span>
                  <select
                    className="voice-select"
                    id="voice-output-device"
                    value={voiceConfig.outputDeviceId}
                    onChange={(event) => updateVoiceConfig("outputDeviceId", event.target.value)}
                  >
                    <option value="">系统默认输出</option>
                    {audioOutputDevices.map((device, index) => (
                      <option key={`${device.deviceId}-${index}`} value={device.deviceId}>
                        {device.label || `音频输出设备 ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" htmlFor="voice-output-device-pattern">
                  <span>自动匹配输出设备名</span>
                  <input
                    id="voice-output-device-pattern"
                    value={voiceConfig.outputDeviceLabelPattern}
                    onChange={(event) => {
                      updateVoiceConfig("outputDeviceId", "");
                      updateVoiceConfig("outputDeviceLabelPattern", event.target.value);
                    }}
                    placeholder="例如 CABLE Input 或 VoiceMeeter AUX Input"
                  />
                </label>
                <label className="field" htmlFor="voice-tts-url">
                  <span>伊蕾娜语音 API</span>
                  <input
                    id="voice-tts-url"
                    value={voiceConfig.ttsApiUrl}
                    onChange={(event) => updateVoiceConfig("ttsApiUrl", event.target.value)}
                  />
                </label>
                <label className="field" htmlFor="voice-history-turns">
                  <span>语音上下文轮数</span>
                  <input
                    id="voice-history-turns"
                    min={1}
                    max={20}
                    type="number"
                    value={voiceConfig.maxHistoryTurns}
                    onChange={(event) =>
                      updateVoiceConfig(
                        "maxHistoryTurns",
                        Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                      )
                    }
                  />
                </label>
              </div>
              <label className="field" htmlFor="voice-ref-audio">
                <span>参考音频路径</span>
                <input
                  id="voice-ref-audio"
                  value={voiceConfig.ttsRefAudioPath}
                  onChange={(event) => updateVoiceConfig("ttsRefAudioPath", event.target.value)}
                />
              </label>
              <label className="field" htmlFor="voice-prompt-text">
                <span>参考音频文本</span>
                <textarea
                  className="voice-textarea"
                  id="voice-prompt-text"
                  value={voiceConfig.ttsPromptText}
                  onChange={(event) => updateVoiceConfig("ttsPromptText", event.target.value)}
                />
              </label>
              <div className="module-note">
                <strong>让 bot 进 OOPZ 麦位：</strong>安装或打开一个虚拟声卡（比如 VB-CABLE、Voicemeeter、Sonar），
                在这里把“语音播放输出设备”选成虚拟声卡的输入端，再去 OOPZ 里把麦克风选成对应的虚拟声卡输出端。
                这样 bot 的合成语音就会从 OOPZ 麦克风发出去。想让 bot 听见 OOPZ 里别人说话，
                把 OOPZ 的播放输出送到一个单独的 Voicemeeter 总线，再把这里的“语音监听输入设备”选成那个总线的 Output。
                当前匹配输入：{resolvedVoiceInputText}。当前匹配输出：{resolvedVoiceOutputText}。
              </div>
              <div className="module-note">
                <strong>当前 Banana/OOPZ 推荐设置：</strong>OOPZ 麦克风选择 Voicemeeter Out B1，OOPZ 扬声器/耳机选择
                Voicemeeter AUX Input。桌面端会把 bot 语音播到 CABLE Input，并监听 Voicemeeter Out B2。
                这条线能让别人听见 bot，也能让 bot 听见别人，同时尽量避开 bot 听见自己的回声。
              </div>
              <div className="service-actions">
                <button
                  className="secondary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void requestAudioDevicePermission()}
                >
                  授权刷新设备列表
                </button>
                <button
                  className="secondary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => {
                    const toneUrl = createTestToneAudioUrl();
                    playVoiceAudio(toneUrl);
                    window.setTimeout(() => URL.revokeObjectURL(toneUrl), 4000);
                    setVoiceStatusText("已播放测试音。去 OOPZ 或虚拟声卡电平表看看有没有进麦。");
                  }}
                >
                  测试输出设备
                </button>
                <button
                  className="primary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void saveVoiceConfig()}
                >
                  保存语音配置
                </button>
                <button
                  className="secondary-button"
                  disabled={voiceBusy}
                  type="button"
                  onClick={() => void clearVoiceHistory()}
                >
                  清空语音上下文
                </button>
              </div>
            </article>
          </section>

          <section className="workspace voice-workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">Voice Timeline</p>
                <h2>语音识别和回复记录</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="ghost-button"
                  disabled={voiceBusy || voiceRecording || voiceAlwaysOn}
                  type="button"
                  onClick={() => void startVoiceRecording()}
                >
                  再说一句
                </button>
              </div>
            </div>

            {voiceLogs.length > 0 ? (
              <div className="voice-log-list">
                {voiceLogs.map((item) => (
                  <article className="voice-log-card" key={item.id}>
                    <div>
                      <p className="service-kicker">你说</p>
                      <p className="voice-transcript">{item.transcript}</p>
                    </div>
                    <div>
                      <p className="service-kicker">茶夕莳回复</p>
                      <p className="voice-reply">{item.replyText}</p>
                    </div>
                    <audio controls src={item.audioUrl} />
                    <p className="service-tip">
                      ASR：{item.asrModel} | 回复模型：{item.replyModel}
                    </p>
                  </article>
                ))}
              </div>
            ) : (
              <section className="fallback-panel">
                <h3>还没有语音记录</h3>
                <p>
                  点“开始录音”后直接说话。第一次使用时系统会请求麦克风权限；如果合成失败，先确认进程面板里的
                  GPT-SoVITS 语音 API 已运行。
                </p>
              </section>
            )}
          </section>
        </>
      ) : (
        <>
          <section className="process-overview-grid">
            {orderedProcesses.map((process) => {
              const selected = process.id === activeProcess?.id;
              const stateClass = process.running
                ? "process-card process-card--running"
                : "process-card";

              return (
                <article
                  className={`${stateClass}${selected ? " process-card--active" : ""}`}
                  key={process.id}
                >
                  <div className="service-header">
                    <div>
                      <p className="service-kicker">进程</p>
                      <h2>{process.name}</h2>
                    </div>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => selectProcess(process.id)}
                    >
                      {selected ? "当前日志" : "查看日志"}
                    </button>
                  </div>
                  <p className="service-description">{process.description}</p>
                  <div className="process-meta-row">
                    <span
                      className={
                        process.running ? "state-pill state-pill--running" : "state-pill"
                      }
                    >
                      {getProcessStateLabel(process)}
                    </span>
                    <span className="meta-note">
                      PID {process.pid ?? "未分配"}
                      {process.runningExternally ? " | 外部实例" : ""}
                    </span>
                  </div>
                  <p className="service-tip">
                    {process.issue ??
                      process.statusNote ??
                      "已接入软件内输出面板，不会再额外弹 cmd。"}
                  </p>
                </article>
              );
            })}
          </section>

          <section className="workspace">
            <div className="workspace-bar">
              <div>
                <p className="workspace-label">进程总控</p>
                <h2>主程序日志和控制台切换</h2>
              </div>
              <div className="workspace-actions">
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "cleanup_process_conflicts",
                      undefined,
                      "正在清理 8001 / 8095 / 6099 / 9880 端口占用...",
                      "端口占用清理完成。现在可以重新启动全部进程。",
                    )
                  }
                >
                  清理端口占用
                </button>
                <button
                  className="danger-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "deep_cleanup_process_state",
                      undefined,
                      "正在执行一键清理：停止残留进程、释放端口并重置心跳状态...",
                      "一键清理完成。现在可以重新启动全部进程。",
                    )
                  }
                >
                  一键清理并重置
                </button>
                <button
                  className="secondary-button secondary-button--warning"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "prepare_stable_qq_login",
                      undefined,
                      "正在执行稳态重登准备：停止 NapCat/Adapter 并清理 QQ 登录链路残留...",
                      "稳态重登准备完成。请确认普通 QQ 没有登录 bot 号，再启动 Adapter 和 NapCat。",
                    )
                  }
                >
                  稳态重登准备
                </button>
                <button
                  className="primary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "start_all_managed_processes",
                      undefined,
                      "正在启动全部内置进程...",
                      "全部进程启动请求已发送。",
                    )
                  }
                >
                  全部启动
                </button>
                <button
                  className="secondary-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "stop_all_managed_processes",
                      undefined,
                      "正在停止全部内置进程...",
                      "全部进程停止请求已发送。",
                    )
                  }
                >
                  全部停止
                </button>
                <button
                  className="ghost-button"
                  disabled={processBusy !== null}
                  type="button"
                  onClick={() =>
                    void runProcessAction(
                      "get_process_snapshots",
                      undefined,
                      "正在刷新进程状态...",
                      "进程状态已刷新。",
                    )
                  }
                >
                  刷新状态
                </button>
              </div>
            </div>

            {hasExternalProcess ? (
              <div className="cleanup-banner">
                检测到已有外部实例占用 MaiBot / Adapter / NapCat / 语音 API
                端口。如果 bot 不回复、QQ 误报异常或你怀疑有残留进程，优先点“一键清理并重置”，再点“全部启动”。
              </div>
            ) : null}

            {loginStabilityReport ? (
              <div
                className={
                  hasLoginStabilityRisk
                    ? "cleanup-banner cleanup-banner--danger"
                    : "cleanup-banner cleanup-banner--ok"
                }
              >
                <strong>QQ 登录稳态：</strong>
                {loginStabilityReport.status}
                <span>
                  {" "}
                  bot号 {loginStabilityReport.qqAccount ?? "未读取"}，普通QQ {normalQqCount}
                  个，NapCat QQ {napcatQqCount} 个，NapCat启动器 {napcatBootCount} 个。
                </span>
                {hasLoginStabilityRisk ? (
                  <ul className="stability-risk-list">
                    {loginRiskMessages.map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {activeProcess ? (
              <>
                <div className="process-tab-row">
                  {orderedProcesses.map((process) => (
                    <button
                      className={
                        process.id === activeProcess.id
                          ? "tab-button tab-button--active"
                          : "tab-button"
                      }
                      key={process.id}
                      type="button"
                      onClick={() => selectProcess(process.id)}
                    >
                      {process.name}
                    </button>
                  ))}
                </div>

                <div className="process-detail-grid">
                  <article className="meta-card">
                    <p className="service-kicker">工作目录</p>
                    <code>{activeProcess.cwd}</code>
                  </article>
                  <article className="meta-card">
                    <p className="service-kicker">启动命令</p>
                    <code>{activeProcess.commandLine}</code>
                  </article>
                  <article className="meta-card">
                    <p className="service-kicker">当前状态</p>
                    <div className="process-meta-row">
                      <span
                        className={
                          activeProcess.running ? "state-pill state-pill--running" : "state-pill"
                        }
                      >
                        {getProcessStateLabel(activeProcess)}
                      </span>
                      <span className="meta-note">
                        {activeProcess.available
                          ? activeProcess.runningExternally
                            ? "外部实例"
                            : activeProcess.managedByApp
                              ? "桌面端接管"
                              : "可启动"
                          : "配置缺失"}
                      </span>
                    </div>
                  </article>
                </div>

                <div className="process-actions-bar">
                  <button
                    className="primary-button"
                    disabled={
                      processBusy !== null ||
                      !activeProcess.available ||
                      activeProcess.running
                    }
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "start_managed_process",
                        { processId: activeProcess.id },
                        `正在启动 ${activeProcess.name} ...`,
                        `${activeProcess.name} 启动请求已发送。`,
                      )
                    }
                  >
                    {activeProcess.runningExternally
                      ? "已由外部运行"
                      : activeProcess.managedByApp
                        ? "当前已运行"
                        : "启动当前进程"}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={processBusy !== null || !activeProcess.managedByApp}
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "stop_managed_process",
                        { processId: activeProcess.id },
                        `正在停止 ${activeProcess.name} ...`,
                        `${activeProcess.name} 停止请求已发送。`,
                      )
                    }
                  >
                    停止当前进程
                  </button>
                  <button
                    className="ghost-button"
                    disabled={processBusy !== null}
                    type="button"
                    onClick={() =>
                      void runProcessAction(
                        "clear_process_logs",
                        { processId: activeProcess.id },
                        `正在清空 ${activeProcess.name} 日志...`,
                        `${activeProcess.name} 日志已清空。`,
                      )
                    }
                  >
                    清空当前日志
                  </button>
                </div>

                <div className="console-shell">
                  <div className="console-toolbar">
                    <div className="console-toolbar-row">
                      <div className="process-meta-row">
                        <span
                          className={
                            activeProcess.running ? "state-pill state-pill--running" : "state-pill"
                          }
                        >
                          {getProcessStateLabel(activeProcess)}
                        </span>
                        <span className="meta-note">
                          PID {activeProcess.pid ?? "未分配"}
                          {activeProcess.runningExternally ? " | 外部实例" : ""}
                        </span>
                        <span className="console-follow-note">
                          {logAutoFollow ? "日志自动跟随中" : "日志已暂停自动跟随"}
                        </span>
                      </div>
                      <div className="console-scroll-actions">
                        <button
                          className="tab-button"
                          type="button"
                          onClick={() => scrollConsoleTo("top")}
                        >
                          到最上面
                        </button>
                        <button
                          className="tab-button"
                          type="button"
                          onClick={() => scrollConsoleTo("bottom")}
                        >
                          到最下面
                        </button>
                      </div>
                    </div>
                    <code>{activeProcess.commandLine}</code>
                  </div>
                  {(!activeProcess.available && activeProcess.issue) || activeProcess.statusNote ? (
                    <div className="process-issue-banner">
                      {activeProcess.issue ?? activeProcess.statusNote}
                    </div>
                  ) : null}
                  <div
                    ref={consoleOutputRef}
                    className="console-output"
                    role="log"
                    aria-live="polite"
                    onScroll={handleConsoleScroll}
                  >
                    {visibleActiveProcessLogLines.length > 0
                      ? renderedActiveProcessLogs
                      : "这里会显示当前进程的 stdout / stderr 输出。启动后不再弹外部 cmd 窗口。"}
                  </div>
                </div>
              </>
            ) : (
              <section className="fallback-panel">
                <h3>进程面板还没拿到数据</h3>
                <p>如果这里长期为空，通常是后端还没编译好或者当前模块路径不完整。</p>
              </section>
            )}
          </section>
        </>
      )}
    </main>
  );
}

export default App;
