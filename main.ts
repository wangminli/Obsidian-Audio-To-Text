import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl
} from "obsidian";
import type { MarkdownFileInfo } from "obsidian";

interface QwenAsrSettings {
  apiKey: string;
  endpoint: string;
  model: string;
  language: string;
  litterboxRetention: string;
  autoTranscribe: boolean;
}

const DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const DEFAULT_MODEL = "qwen3-asr-flash-filetrans";
const LITTERBOX_ENDPOINT = "https://litterbox.catbox.moe/resources/internals/api.php";
const DEFAULT_LITTERBOX_RETENTION = "24h";
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_SETTINGS: QwenAsrSettings = {
  apiKey: "",
  endpoint: DEFAULT_ENDPOINT,
  model: DEFAULT_MODEL,
  language: "",
  litterboxRetention: DEFAULT_LITTERBOX_RETENTION,
  autoTranscribe: false
};

const AUDIO_EXTENSIONS = new Set([
  "3gp",
  "aac",
  "flac",
  "m4a",
  "mp3",
  "ogg",
  "opus",
  "wav",
  "webm",
  "wma"
]);

// Kept only so older generated blocks can still be found and replaced.
const LEGACY_TRANSCRIPTION_START = "<!-- qwen3-asr:transcription -->";
const LEGACY_TRANSCRIPTION_END = "<!-- /qwen3-asr:transcription -->";
const TRANSCRIPTION_HEADING = "### 语音转文本";
const LEGACY_TRANSCRIPTION_HEADING = "### 语音转文字";
const TRANSCRIPTION_SEPARATOR = "---";

interface AudioReference {
  linkPath: string;
  file: TFile;
}

interface SelectionTarget {
  reference: AudioReference;
  line: number;
}

interface MinuteSegment {
  minute: number;
  text: string;
}

interface TranscriptionResult {
  text: string;
  segments: MinuteSegment[];
}

interface AutoTranscriptionTimer {
  timer: number;
  editor: Editor;
  sourceFile: TFile;
  line: number;
}

export default class QwenAsrPlugin extends Plugin {
  settings: QwenAsrSettings = { ...DEFAULT_SETTINGS };
  private activeTranscriptions = new Set<string>();
  private autoTranscriptionTimers = new Map<string, AutoTranscriptionTimer>();
  private autoScanTimers = new Map<string, number>();
  private autoRetryKeys = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new QwenAsrSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
        const sourceFile = info.file;
        const target = this.findSelectionTarget(editor, sourceFile);
        if (!target || !sourceFile) return;

        menu.addItem((item) => {
          item
            .setTitle("语音转文本")
            .setIcon("audio-lines")
            .onClick(() => {
              void this.transcribeTarget(target, editor, sourceFile);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        const sourceFile = info.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!this.settings.autoTranscribe || !sourceFile) return;
        this.scheduleAutoTranscriptionScan(editor, sourceFile);
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-paste", (_event, editor, info) => {
        const sourceFile = info.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!this.settings.autoTranscribe || !sourceFile) return;
        this.scheduleAutoTranscriptionScan(editor, sourceFile, 250);
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-drop", (_event, editor, info) => {
        const sourceFile = info.file ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
        if (!this.settings.autoTranscribe || !sourceFile) return;
        this.scheduleAutoTranscriptionScan(editor, sourceFile, 250);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.autoTranscribe || !(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file || view.file.path !== file.path) return;
        this.scheduleAutoTranscriptionScan(view.editor, file, 250);
      })
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!this.settings.autoTranscribe) return;
        const view = leaf?.view instanceof MarkdownView ? leaf.view : null;
        if (view?.file) this.scheduleAutoTranscriptionScan(view.editor, view.file, 500);
      })
    );
    this.app.workspace.onLayoutReady(() => {
      this.scheduleActiveViewAutoTranscription(500);
    });
    this.register(() => {
      for (const entry of this.autoTranscriptionTimers.values()) window.clearTimeout(entry.timer);
      this.autoTranscriptionTimers.clear();
      for (const timer of this.autoScanTimers.values()) window.clearTimeout(timer);
      this.autoScanTimers.clear();
      this.autoRetryKeys.clear();
    });

    this.addCommand({
      id: "transcribe-selected-audio",
      name: "将选中的音频转成文字",
      editorCallback: (editor, view) => {
        const sourceFile = view.file;
        const target = this.findSelectionTarget(editor, sourceFile);
        if (!target || !sourceFile) {
          new Notice("请先选中一个音频引用（例如 ![[recording.mp3]]）。");
          return;
        }
        void this.transcribeTarget(target, editor, sourceFile);
      }
    });
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<QwenAsrSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});

    // Migrate settings created by the previous OpenAI-compatible implementation.
    if (
      this.settings.endpoint.includes("/compatible-mode/") ||
      this.settings.endpoint.endsWith("/audio/transcriptions") ||
      this.settings.endpoint.endsWith("/chat/completions")
    ) {
      this.settings.endpoint = DEFAULT_ENDPOINT;
    }
    if (!this.settings.model || this.settings.model === "qwen3-asr-flash") {
      this.settings.model = DEFAULT_MODEL;
    }
    if (!["1h", "12h", "24h", "72h"].includes(this.settings.litterboxRetention)) {
      this.settings.litterboxRetention = DEFAULT_LITTERBOX_RETENTION;
    }
    this.settings.autoTranscribe = Boolean(this.settings.autoTranscribe);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  scheduleActiveViewAutoTranscription(delayMs = 250): void {
    if (!this.settings.autoTranscribe) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file) this.scheduleAutoTranscriptionScan(view.editor, view.file, delayMs);
  }

  private findSelectionTarget(editor: Editor, sourceFile: TFile | null): SelectionTarget | null {
    if (!sourceFile) return null;

    const selection = editor.getSelection().trim();
    if (!selection) return null;

    const linkPath = extractAudioLinkPath(selection);
    if (!linkPath) return null;

    return this.resolveTarget(linkPath, sourceFile, editor.getCursor("from").line);
  }

  private findLineTarget(editor: Editor, sourceFile: TFile, line: number): SelectionTarget | null {
    if (line < 0 || line >= editor.lineCount()) return null;
    const linkPath = extractAudioLinkPath(editor.getLine(line).trim());
    return linkPath ? this.resolveTarget(linkPath, sourceFile, line) : null;
  }

  private scheduleAutoTranscriptionScan(editor: Editor, sourceFile: TFile, delayMs = 350): void {
    const key = sourceFile.path;
    const previous = this.autoScanTimers.get(key);
    if (previous !== undefined) window.clearTimeout(previous);

    const timer = window.setTimeout(() => {
      this.autoScanTimers.delete(key);
      this.scanAutoTranscriptionTargets(editor, sourceFile);
    }, delayMs);
    this.autoScanTimers.set(key, timer);
  }

  private scanAutoTranscriptionTargets(editor: Editor, sourceFile: TFile): void {
    for (let line = 0; line < editor.lineCount(); line += 1) {
      if (findTranscriptionAfterLine(editor, line)) continue;

      const lineText = editor.getLine(line).trim();
      const linkPath = extractAudioLinkPath(lineText);
      if (!linkPath) continue;

      const target = this.resolveTarget(linkPath, sourceFile, line);
      if (target) this.queueAutoTranscription(target, editor, sourceFile);
      else this.retryAutoTranscription(editor, sourceFile, line);
    }
  }

  private retryAutoTranscription(editor: Editor, sourceFile: TFile, line: number, attempt = 0): void {
    const lineText = editor.getLine(line).trim();
    const linkPath = extractAudioLinkPath(lineText);
    if (!linkPath) return;

    const retryKey = `${sourceFile.path}:${line}:${linkPath}`;
    if (attempt === 0 && this.autoRetryKeys.has(retryKey)) return;
    if (attempt === 0) this.autoRetryKeys.add(retryKey);
    if (attempt >= 10) {
      this.autoRetryKeys.delete(retryKey);
      return;
    }

    window.setTimeout(() => {
      if (!this.settings.autoTranscribe || findTranscriptionAfterLine(editor, line)) {
        this.autoRetryKeys.delete(retryKey);
        return;
      }
      const target = this.findLineTarget(editor, sourceFile, line);
      if (target) {
        this.autoRetryKeys.delete(retryKey);
        this.queueAutoTranscription(target, editor, sourceFile);
      } else {
        this.retryAutoTranscription(editor, sourceFile, line, attempt + 1);
      }
    }, Math.min(1000, 250 * (attempt + 1)));
  }

  private resolveTarget(linkPath: string, sourceFile: TFile, line: number): SelectionTarget | null {
    const metadataFile = this.app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);
    if (metadataFile && isAudioFile(metadataFile)) {
      return { reference: { linkPath, file: metadataFile }, line };
    }

    // A freshly pasted wikilink may arrive before metadataCache has indexed it.
    // Resolve exact paths and unique basename matches directly from the Vault.
    const normalizedPath = linkPath.replace(/^\/+/, "");
    const directFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (directFile instanceof TFile && isAudioFile(directFile)) {
      return { reference: { linkPath, file: directFile }, line };
    }

    const matches = this.app.vault.getFiles().filter((file) =>
      isAudioFile(file) && (file.path === normalizedPath || file.path.endsWith(`/${normalizedPath}`) || file.name === normalizedPath)
    );
    if (matches.length !== 1) return null;
    return { reference: { linkPath, file: matches[0] }, line };
  }

  private queueAutoTranscription(target: SelectionTarget, editor: Editor, sourceFile: TFile): void {
    const key = `${sourceFile.path}:${target.line}:${target.reference.file.path}`;
    const previous = this.autoTranscriptionTimers.get(key);
    if (previous) window.clearTimeout(previous.timer);

    const timer = window.setTimeout(() => {
      this.autoTranscriptionTimers.delete(key);
      const currentTarget = this.findLineTarget(editor, sourceFile, target.line);
      if (!currentTarget || findTranscriptionAfterLine(editor, target.line)) return;
      void this.transcribeTarget(currentTarget, editor, sourceFile);
    }, 700);
    this.autoTranscriptionTimers.set(key, { timer, editor, sourceFile, line: target.line });
  }

  private async transcribeTarget(target: SelectionTarget, editor: Editor, sourceFile: TFile): Promise<void> {
    const key = `${sourceFile.path}:${target.reference.file.path}`;
    if (this.activeTranscriptions.has(key)) {
      new Notice("这个音频正在转写，请稍候。");
      return;
    }

    if (!this.settings.apiKey.trim()) {
      new Notice("请先在设置中填写转写服务 API Key。");
      return;
    }

    this.activeTranscriptions.add(key);
    const notice = new Notice(`正在准备转写：${target.reference.file.name}`, 0);

    try {
      const result = await this.transcribeAudioFile(target.reference.file, notice);
      if (!result.text.trim()) throw new Error("模型返回了空的转写结果。");

      insertTranscription(editor, target.line, result);
      notice.hide();
      new Notice("语音转文本完成。");
    } catch (error) {
      notice.hide();
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`语音转文本失败：${message}`);
      console.error("Audio to Text transcription failed", error);
    } finally {
      this.activeTranscriptions.delete(key);
    }
  }

  private async transcribeAudioFile(file: TFile, notice: Notice): Promise<TranscriptionResult> {
    const binary = await this.app.vault.readBinary(file);

    notice.setMessage(`正在上传音频：${file.name}`);
    const fileUrl = await this.uploadToLitterbox(binary, file);

    notice.setMessage("已上传，正在提交转写任务…");
    const taskId = await this.createTranscriptionTask(fileUrl);

    return this.waitForTranscription(taskId, notice);
  }

  private async uploadToLitterbox(binary: ArrayBuffer, file: TFile): Promise<string> {
    const boundary = `----QwenAsrLitterbox${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const contentType = mimeTypeForExtension(file.extension);
    const safeFilename = file.name.replace(/[\r\n"]/g, "_");
    const body = multipartBody(boundary, [
      { name: "reqtype", value: "fileupload" },
      { name: "time", value: this.settings.litterboxRetention },
      { name: "fileToUpload", filename: safeFilename, contentType, binary }
    ]);

    const response = await requestUrl({
      url: LITTERBOX_ENDPOINT,
      method: "POST",
      contentType: `multipart/form-data; boundary=${boundary}`,
      body,
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = parseApiError(response.text);
      throw new Error(`Litterbox 上传失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）。`);
    }

    const fileUrl = response.text.trim();
    if (!/^https?:\/\/[^\s]+$/i.test(fileUrl)) {
      throw new Error(`Litterbox 返回了无效下载地址：${fileUrl || "空响应"}`);
    }
    return fileUrl;
  }

  private async createTranscriptionTask(fileUrl: string): Promise<string> {
    const payload = {
      model: this.settings.model.trim() || DEFAULT_MODEL,
      input: { file_url: fileUrl },
      parameters: {
        channel_id: [0],
        enable_itn: false,
        enable_words: true,
        ...(this.settings.language.trim() ? { language: this.settings.language.trim() } : {})
      }
    };

    const response = await requestUrl({
      url: this.settings.endpoint.trim() || DEFAULT_ENDPOINT,
      method: "POST",
      contentType: "application/json",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify(payload),
      throw: false
    });

    if (response.status < 200 || response.status >= 300) {
      const detail = parseApiError(response.text);
      throw new Error(`提交转写任务失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）。`);
    }

    const payloadJson = parseJson(response.text);
    const taskId = findString(payloadJson, ["task_id"]);
    if (!taskId) throw new Error("接口没有返回 task_id。");
    return taskId;
  }

  private async waitForTranscription(taskId: string, notice: Notice): Promise<TranscriptionResult> {
    const taskUrl = createTaskUrl(this.settings.endpoint, taskId);
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const response = await requestUrl({
        url: taskUrl,
        method: "GET",
        headers: { Authorization: `Bearer ${this.settings.apiKey.trim()}` },
        throw: false
      });

      if (response.status < 200 || response.status >= 300) {
        const detail = parseApiError(response.text);
        throw new Error(`查询转写任务失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）。`);
      }

      const payload = parseJson(response.text);
      const status = (findString(payload, ["task_status", "status"]) ?? "").toUpperCase();
      if (status === "SUCCEEDED" || status === "SUCCESS") {
        const transcriptionUrl = findString(payload, ["transcription_url"]);
        if (!transcriptionUrl) throw new Error("转写任务已完成，但没有返回 transcription_url。");
        notice.setMessage("转写完成，正在下载识别结果…");
        return this.downloadTranscription(transcriptionUrl);
      }
      if (status === "FAILED" || status === "CANCELED" || status === "CANCELLED") {
        const detail = findString(payload, ["message", "error", "error_message"]);
        throw new Error(`转写任务${status === "FAILED" ? "失败" : "已取消"}${detail ? `：${detail}` : "。"}`);
      }

      notice.setMessage(`正在转写音频…（${status || "PENDING"}）`);
      await delay(POLL_INTERVAL_MS);
    }

    throw new Error("转写任务等待超时（超过 30 分钟）。");
  }

  private async downloadTranscription(url: string): Promise<TranscriptionResult> {
    const response = await requestUrl({ url, method: "GET", throw: false });
    if (response.status < 200 || response.status >= 300) {
      const detail = parseApiError(response.text);
      throw new Error(`下载识别结果失败（HTTP ${response.status}${detail ? `：${detail}` : ""}）。`);
    }

    const payload = parseJson(response.text);
    const text = extractTranscriptionText(payload);
    if (!text) throw new Error("识别结果中没有找到 transcripts[].text。");
    const segments = extractMinuteSegments(payload);
    return { text, segments: segments.length > 0 ? segments : [{ minute: 0, text }] };
  }
}

class QwenAsrSettingTab extends PluginSettingTab {
  plugin: QwenAsrPlugin;

  constructor(app: App, plugin: QwenAsrPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Audio to Text" });

    new Setting(containerEl)
      .setName("转写服务 API Key")
      .setDesc("用于访问当前配置的语音转写服务。")
      .addText((text) => {
        text.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey);
        text.inputEl.type = "password";
        text.onChange(async (value) => {
          this.plugin.settings.apiKey = value.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("模型")
      .setDesc("当前转写服务支持的模型名称。")
      .addText((text) =>
        text.setPlaceholder(DEFAULT_MODEL).setValue(this.plugin.settings.model).onChange(async (value) => {
          this.plugin.settings.model = value.trim() || DEFAULT_MODEL;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("接口地址")
      .setDesc("当前转写服务的接口地址。")
      .addText((text) =>
        text.setPlaceholder(DEFAULT_ENDPOINT).setValue(this.plugin.settings.endpoint).onChange(async (value) => {
          this.plugin.settings.endpoint = value.trim() || DEFAULT_ENDPOINT;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("语言（可选）")
      .setDesc("例如 zh、en；留空时由模型自动识别。")
      .addText((text) =>
        text.setPlaceholder("自动识别").setValue(this.plugin.settings.language).onChange(async (value) => {
          this.plugin.settings.language = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("自动转文字")
      .setDesc("开启后，在编辑器中输入或粘贴音频引用时自动开始转写。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoTranscribe).onChange(async (value) => {
          this.plugin.settings.autoTranscribe = value;
          await this.plugin.saveSettings();
          if (value) this.plugin.scheduleActiveViewAutoTranscription();
        })
      );

    containerEl.createEl("h3", { text: "临时文件上传" });
    containerEl.createDiv({ text: "音频会先上传到临时文件服务，再将下载地址提交给转写服务。文件到期后由上传服务自动删除。" });

    new Setting(containerEl)
      .setName("临时文件保留时间")
      .setDesc("建议选择 24 小时，给异步转写任务留出排队时间。")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("1h", "1 小时")
          .addOption("12h", "12 小时")
          .addOption("24h", "24 小时")
          .addOption("72h", "3 天")
          .setValue(this.plugin.settings.litterboxRetention)
          .onChange(async (value) => {
            this.plugin.settings.litterboxRetention = value;
            await this.plugin.saveSettings();
          });
      });

    const help = containerEl.createDiv({ cls: "qwen-asr-settings-warning" });
    help.setText("Litterbox 是第三方临时文件服务；拿到下载链接的人可以访问音频，请勿上传高度敏感或受监管内容。文件会按所选时间自动过期。");
  }
}

function extractAudioLinkPath(selection: string): string | null {
  const wikilink = selection.match(/!?\[\[([^\]]+)\]\]/);
  if (wikilink) return cleanLinkPath(wikilink[1]);

  const markdown = selection.match(/!?\[[^\]]*\]\(([^)]+)\)/);
  if (markdown) return cleanLinkPath(markdown[1]);

  const bare = cleanLinkPath(selection.replace(/^!/, ""));
  return bare && looksLikeAudioPath(bare) ? bare : null;
}

function cleanLinkPath(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^<|>$/g, "")
    .split("|", 1)[0]
    .split("#", 1)[0]
    .split("?", 1)[0]
    .trim();
  try {
    return decodeURIComponent(cleaned);
  } catch {
    return cleaned;
  }
}

function looksLikeAudioPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return Boolean(extension && AUDIO_EXTENSIONS.has(extension));
}

function isAudioFile(file: TFile): boolean {
  return file.extension ? AUDIO_EXTENSIONS.has(file.extension.toLowerCase()) : false;
}

function mimeTypeForExtension(extension: string): string {
  const mimeByExtension: Record<string, string> = {
    aac: "audio/aac",
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    opus: "audio/opus",
    wav: "audio/wav",
    webm: "audio/webm",
    wma: "audio/x-ms-wma",
    "3gp": "audio/3gpp"
  };
  return mimeByExtension[extension.toLowerCase()] ?? "application/octet-stream";
}


interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  binary?: ArrayBuffer;
}

function multipartBody(boundary: string, parts: MultipartPart[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}`
      : `Content-Disposition: form-data; name="${part.name}"`;
    chunks.push(encoder.encode(`--${boundary}\r\n${disposition}\r\n\r\n`));
    if (part.binary) chunks.push(new Uint8Array(part.binary));
    else chunks.push(encoder.encode(part.value ?? ""));
    chunks.push(encoder.encode("\r\n"));
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function createTaskUrl(endpoint: string, taskId: string): string {
  try {
    const url = new URL(endpoint || DEFAULT_ENDPOINT);
    url.pathname = "/api/v1/tasks/" + encodeURIComponent(taskId);
    url.search = "";
    return url.toString();
  } catch {
    return `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("接口返回的不是有效 JSON。");
  }
}

function findString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const key of ["output", "result", "data", "output_result"]) {
    const nested = findString(value[key], keys);
    if (nested) return nested;
  }
  return null;
}

function extractTranscriptionText(value: unknown): string {
  if (!isRecord(value)) return typeof value === "string" ? value.trim() : "";

  const transcripts = value.transcripts;
  if (Array.isArray(transcripts)) {
    const text = transcripts
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text.trim() : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }

  for (const key of ["text", "transcript", "transcription"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const key of ["output", "result", "data", "output_result"]) {
    const text = extractTranscriptionText(value[key]);
    if (text) return text;
  }
  return "";
}

function extractMinuteSegments(value: unknown): MinuteSegment[] {
  const transcripts = findTranscripts(value);
  if (transcripts.length === 0) return [];

  const buckets = new Map<number, string[]>();
  const add = (minute: number, text: string): void => {
    const cleaned = text.trim();
    if (!cleaned) return;
    const bucket = buckets.get(minute) ?? [];
    bucket.push(cleaned);
    buckets.set(minute, bucket);
  };

  for (const transcript of transcripts) {
    if (!isRecord(transcript)) continue;
    const sentences = normalizeArray(transcript.sentences);
    if (sentences.length === 0) {
      if (typeof transcript.text === "string") add(0, transcript.text);
      continue;
    }

    for (const sentence of sentences) {
      if (!isRecord(sentence)) continue;
      const words = normalizeArray(sentence.words);
      const timedWords = words.filter(
        (word): word is Record<string, unknown> =>
          isRecord(word) && numberValue(word.begin_time) !== null && typeof word.text === "string"
      );
      if (timedWords.length > 0) {
        for (const word of timedWords) {
          const wordText = `${word.text as string}${typeof word.punctuation === "string" ? word.punctuation : ""}`;
          add(Math.max(0, Math.floor((numberValue(word.begin_time) as number) / 60000)), wordText);
        }
        continue;
      }

      const sentenceText = typeof sentence.text === "string" ? sentence.text : "";
      const beginTime = numberValue(sentence.begin_time) ?? 0;
      add(Math.max(0, Math.floor(beginTime / 60000)), sentenceText);
    }
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([minute, texts]) => ({ minute, text: texts.join("").trim() }))
    .filter((segment) => segment.text.length > 0);
}

function findTranscripts(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.transcripts)) return value.transcripts;
  for (const key of ["output", "result", "data", "output_result"]) {
    const nested = findTranscripts(value[key]);
    if (nested.length > 0) return nested;
  }
  return [];
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (typeof value.text === "string" || typeof value.begin_time === "number") return [value];
    return Object.keys(value).map((key) => value[key]);
  }
  return [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseApiError(raw: string): string {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (isRecord(payload)) {
      const error = payload.error;
      if (typeof error === "string") return error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof payload.message === "string") return payload.message;
      if (typeof payload.code === "string") return payload.code;
    }
  } catch {
    // Fall through to the raw response for non-JSON errors.
  }
  return raw.trim() || "接口返回了错误。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function insertTranscription(editor: Editor, line: number, result: TranscriptionResult): void {
  const lineCount = editor.lineCount();
  const targetLine = Math.min(Math.max(line, 0), lineCount - 1);
  const existing = findTranscriptionAfterLine(editor, targetLine);
  const block = formatTranscription(result);

  if (existing) {
    editor.replaceRange(
      block,
      { line: existing.startLine, ch: 0 },
      { line: existing.endLine, ch: editor.getLine(existing.endLine).length }
    );
    return;
  }

  editor.replaceRange(`\n\n${block}\n`, { line: targetLine, ch: editor.getLine(targetLine).length });
}

function formatTranscription(result: TranscriptionResult): string {
  const sections = result.segments.map((segment) => {
    const text = segment.text.trim();
    return `**${minuteLabel(segment.minute)}**\n\n${text}`;
  });
  return `${TRANSCRIPTION_HEADING}\n\n${sections.join("\n\n")}\n\n${TRANSCRIPTION_SEPARATOR}`;
}

function minuteLabel(minute: number): string {
  return `${formatClock(minute * 60)} - ${formatClock((minute + 1) * 60)}`;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function findTranscriptionAfterLine(editor: Editor, line: number): { startLine: number; endLine: number } | null {
  const firstLine = line + 1;
  if (firstLine >= editor.lineCount()) return null;

  let startLine = firstLine;
  while (startLine < editor.lineCount() && editor.getLine(startLine).trim() === "") startLine += 1;
  if (startLine >= editor.lineCount()) return null;

  const startText = editor.getLine(startLine).trim();
  if (startText === LEGACY_TRANSCRIPTION_START) {
    let endLine = startLine + 1;
    while (endLine < editor.lineCount() && editor.getLine(endLine).trim() !== LEGACY_TRANSCRIPTION_END) endLine += 1;
    return endLine < editor.lineCount() ? { startLine, endLine } : null;
  }

  if (startText !== TRANSCRIPTION_HEADING && startText !== LEGACY_TRANSCRIPTION_HEADING) return null;

  let endLine = startLine + 1;
  while (endLine < editor.lineCount() && editor.getLine(endLine).trim() !== TRANSCRIPTION_SEPARATOR) endLine += 1;
  return endLine < editor.lineCount() ? { startLine, endLine } : null;
}
