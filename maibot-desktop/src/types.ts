export type ViewMode = "services" | "processes" | "voice";

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
  maxHistoryTurns: number;
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
