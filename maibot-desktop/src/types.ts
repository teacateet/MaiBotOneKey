export type ViewMode = "services" | "processes" | "voice" | "live" | "game";

export type ServiceId = "maibot" | "napcat";

export type ServiceEndpoint = {
  id: ServiceId;
  name: string;
  description: string;
  defaultUrl: string;
  troubleshootingTip: string;
};

export type ProcessSnapshot = {
  id: string;
  name: string;
  description: string;
  cwd: string;
  program: string;
  args: string[];
  commandLine: string;
  available: boolean;
  issue: string | null;
  running: boolean;
  pid: number | null;
  managedByApp: boolean;
  runningExternally: boolean;
  statusNote: string | null;
  logLines: string[];
};

export type OfflineAlert = {
  id: string;
  processId: string;
  title: string;
  summary: string;
  detail: string;
};

export type LoginStabilityProcess = {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
};

export type LoginStabilityReport = {
  qqAccount: string | null;
  normalQqProcesses: LoginStabilityProcess[];
  napcatQqProcesses: LoginStabilityProcess[];
  napcatBootProcesses: LoginStabilityProcess[];
  riskMessages: string[];
  status: string;
};

export type LoginHelperConfig = {
  recipientEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpFrom: string;
  smtpUseSsl: boolean;
};

export type LoginHelperStatus = {
  maibotWebuiUrl: string;
  maibotAccessToken: string;
  napcatWebuiUrl: string;
  napcatToken: string;
  qqAccount: string | null;
  mailConfigured: boolean;
};

export type MaicraftConfig = {
  host: string;
  port: number;
  version: string;
  username: string;
  auth: string;
  forgeModern: boolean;
  keepAliveTimeout: number;
  goal: string;
  forgeClientPath: string;
};

export type ForgeBridgeStatus = {
  ok: boolean;
  connected: boolean;
  lastCommandAt: number;
  controlUntil: number;
  screen: string;
  name?: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  health?: number;
  food?: number;
  dimension?: string;
  controls?: Record<string, boolean>;
  task?: {
    mode?: string;
    status?: string;
    until?: number;
    targets?: string[];
    target?: {
      x?: number;
      y?: number;
      z?: number;
    };
  };
  ysm?: {
    installed?: boolean;
    screenOpen?: boolean;
    screen?: string;
    menuClass?: string;
  };
};

export type ForgeBridgeScanBlock = {
  id: string;
  name?: string;
  x: number;
  y: number;
  z: number;
  distance: number;
};

export type ForgeBridgeScanResponse = {
  ok: boolean;
  connected: boolean;
  radius: number;
  targets: string[];
  blocks: ForgeBridgeScanBlock[];
};

export type ForgeBridgeCommandRequest = Record<string, string | number | boolean>;

export type VoiceChatConfig = {
  asrApiKey: string;
  asrBaseUrl: string;
  asrTranscriptionPath: string;
  asrModel: string;
  volcAsrAppId: string;
  volcAsrApiKey: string;
  volcAsrAccessToken: string;
  volcAsrSecretKey: string;
  volcAsrSubmitUrl: string;
  volcAsrQueryUrl: string;
  volcAsrUrl: string;
  volcAsrResourceId: string;
  volcAsrModel: string;
  ttsApiUrl: string;
  ttsRefAudioPath: string;
  ttsPromptText: string;
  ttsPromptLang: string;
  outputLanguage: string;
  inputDeviceId: string;
  inputDeviceLabelPattern: string;
  outputDeviceId: string;
  outputDeviceLabelPattern: string;
  maxHistoryTurns: number;
  bilibiliRoomId: string;
  liveDanmakuReplyEnabled: boolean;
  liveDanmakuCooldownSeconds: number;
  gameEventVoiceEnabled: boolean;
  gameEventVoiceCooldownSeconds: number;
};

export type VoiceChatResponse = {
  transcript: string;
  replyText: string;
  audioBase64: string;
  audioMime: string;
  asrModel: string;
  replyModel: string;
};

export type VoiceChatLogItem = {
  id: string;
  transcript: string;
  replyText: string;
  audioUrl: string;
  asrModel: string;
  replyModel: string;
};
