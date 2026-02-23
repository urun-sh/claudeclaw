import { ensureProjectClaudeMd, run, runUserMessage } from "../runner";
import { getSettings, loadSettings } from "../config";
import { resetSession } from "../sessions";

// --- Markdown → Slack mrkdwn conversion ---

function markdownToSlackMrkdwn(text: string): string {
  if (!text) return "";

  // 1. Extract and protect code blocks
  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract and protect inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // 3. Strip markdown headers — bold the text instead
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 4. Blockquotes → Slack quote
  text = text.replace(/^>\s*(.*)$/gm, "> $1");

  // 5. Links [text](url) → Slack format <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 6. Bold **text** or __text__ → Slack *text*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  text = text.replace(/__(.+?)__/g, "*$1*");

  // 7. Italic _text_ → Slack _text_ (already compatible)

  // 8. Strikethrough ~~text~~ → Slack ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // 9. Bullet lists (already compatible with Slack)

  // 10. Restore inline code
  for (let i = 0; i < inlineCodes.length; i++) {
    text = text.replace(`\x00IC${i}\x00`, `\`${inlineCodes[i]}\``);
  }

  // 11. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`\x00CB${i}\x00`, `\`\`\`${codeBlocks[i]}\`\`\``);
  }

  return text;
}

// --- Slack Web API (raw fetch, zero deps) ---

const SLACK_API = "https://slack.com/api";

let slackDebug = false;

function debugLog(message: string): void {
  if (!slackDebug) return;
  console.log(`[Slack][debug] ${message}`);
}

async function slackApi<T>(botToken: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${botToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Slack API ${method}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as any;
  if (!data.ok) {
    throw new Error(`Slack API ${method}: ${data.error ?? "unknown error"}`);
  }
  return data as T;
}

async function postMessage(botToken: string, channel: string, text: string, threadTs?: string): Promise<void> {
  const mrkdwn = markdownToSlackMrkdwn(text);
  const MAX_LEN = 4000;
  for (let i = 0; i < mrkdwn.length; i += MAX_LEN) {
    await slackApi(botToken, "chat.postMessage", {
      channel,
      text: mrkdwn.slice(i, i + MAX_LEN),
      thread_ts: threadTs,
    });
  }
}

async function addReaction(botToken: string, channel: string, timestamp: string, name: string): Promise<void> {
  await slackApi(botToken, "reactions.add", {
    channel,
    timestamp,
    name,
  }).catch(() => {});
}

// --- Socket Mode (WebSocket-based, zero deps) ---

interface SlackSocketMessage {
  type: string;
  envelope_id?: string;
  payload?: {
    event?: SlackEvent;
    type?: string;
  };
  retry_attempt?: number;
  retry_reason?: string;
}

interface SlackEvent {
  type: string;
  subtype?: string;
  text?: string;
  user?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: SlackFile[];
  channel_type?: string;
}

interface SlackFile {
  id: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
}

interface SlackAuthTest {
  ok: boolean;
  user_id?: string;
  user?: string;
  bot_id?: string;
}

let botUserId: string | null = null;

function extractSlackCommand(text: string): string | null {
  const cleaned = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const firstToken = cleaned.split(/\s+/, 1)[0];
  if (!firstToken || !firstToken.startsWith("/")) return null;
  return firstToken.toLowerCase();
}

function stripBotMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function isBotMentioned(text: string): boolean {
  if (!botUserId) return false;
  return text.includes(`<@${botUserId}>`);
}

function extractReactionDirective(text: string): { cleanedText: string; reactionName: string | null } {
  let reactionName: string | null = null;
  const cleanedText = text
    .replace(/\[react:([^\]\r\n]+)\]/gi, (_match, raw) => {
      const candidate = String(raw).trim();
      if (!reactionName && candidate) reactionName = candidate;
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, reactionName };
}

// --- Message handler ---

async function handleSlackMessage(event: SlackEvent): Promise<void> {
  const config = getSettings().slack;
  const channel = event.channel;
  const userId = event.user;
  const text = event.text ?? "";
  const threadTs = event.thread_ts ?? event.ts;
  const isDm = event.channel_type === "im";

  if (!channel) return;

  // Skip bot messages
  if (event.bot_id) return;
  if (event.subtype === "bot_message") return;
  if (userId && userId === botUserId) return;

  // In channels, only respond if mentioned
  if (!isDm && !isBotMentioned(text)) {
    debugLog(`Skip channel message channel=${channel} from=${userId ?? "unknown"} reason=not_mentioned`);
    return;
  }

  // Check allowed channels (empty = all allowed)
  if (config.allowedChannelIds.length > 0 && !config.allowedChannelIds.includes(channel)) {
    debugLog(`Skip message channel=${channel} from=${userId ?? "unknown"} reason=channel_not_allowed`);
    return;
  }

  const messageText = isDm ? text : stripBotMention(text);

  if (!messageText.trim()) {
    debugLog(`Skip message channel=${channel} from=${userId ?? "unknown"} reason=empty_text`);
    return;
  }

  const command = extractSlackCommand(messageText);
  if (command === "/reset") {
    await resetSession();
    await postMessage(config.botToken, channel, "Session reset. Next message starts fresh.", threadTs);
    return;
  }

  const label = userId ?? "unknown";
  console.log(
    `[${new Date().toLocaleTimeString()}] Slack ${label}: "${messageText.slice(0, 60)}${messageText.length > 60 ? "..." : ""}"`
  );

  try {
    const promptParts = [`[Slack from ${label}]`];
    if (messageText.trim()) promptParts.push(`Message: ${messageText}`);

    const prefixedPrompt = promptParts.join("\n");
    const result = await runUserMessage("slack", prefixedPrompt);

    if (result.exitCode !== 0) {
      await postMessage(
        config.botToken,
        channel,
        `Error (exit ${result.exitCode}): ${result.stderr || "Unknown error"}`,
        threadTs,
      );
    } else {
      const { cleanedText, reactionName } = extractReactionDirective(result.stdout || "");
      if (reactionName && event.ts) {
        await addReaction(config.botToken, channel, event.ts, reactionName);
      }
      await postMessage(config.botToken, channel, cleanedText || "(empty response)", threadTs);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Slack] Error for ${label}: ${errMsg}`);
    await postMessage(config.botToken, channel, `Error: ${errMsg}`, threadTs);
  }
}

// --- Socket Mode connection ---

let running = true;

async function connectSocketMode(appToken: string): Promise<void> {
  // Request a WebSocket URL from Slack
  const res = await fetch(`${SLACK_API}/apps.connections.open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${appToken}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Slack apps.connections.open: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as any;
  if (!data.ok) {
    throw new Error(`Slack apps.connections.open: ${data.error ?? "unknown error"}`);
  }

  const wsUrl = data.url;
  debugLog(`Socket Mode connecting to ${wsUrl}`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let pingInterval: ReturnType<typeof setInterval> | null = null;

    ws.addEventListener("open", () => {
      console.log("[Slack] Socket Mode connected");
      // Keep alive with periodic pings
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
    });

    ws.addEventListener("message", (rawEvent) => {
      try {
        const msg: SlackSocketMessage = JSON.parse(
          typeof rawEvent.data === "string" ? rawEvent.data : new TextDecoder().decode(rawEvent.data as ArrayBuffer)
        );

        debugLog(`Socket message type=${msg.type} envelope_id=${msg.envelope_id ?? "none"}`);

        // Always acknowledge envelope messages immediately
        if (msg.envelope_id) {
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        }

        if (msg.type === "events_api" && msg.payload?.event) {
          const event = msg.payload.event;
          if (event.type === "message" && !event.subtype) {
            handleSlackMessage(event).catch((err) => {
              console.error(`[Slack] Unhandled: ${err}`);
            });
          } else if (event.type === "app_mention") {
            handleSlackMessage(event).catch((err) => {
              console.error(`[Slack] Unhandled app_mention: ${err}`);
            });
          }
        }
      } catch (err) {
        debugLog(`Failed to parse socket message: ${err}`);
      }
    });

    ws.addEventListener("close", (closeEvent) => {
      if (pingInterval) clearInterval(pingInterval);
      console.log(`[Slack] Socket Mode disconnected (code=${closeEvent.code})`);
      if (running) {
        // Reconnect after a short delay
        console.log("[Slack] Reconnecting in 5s...");
        setTimeout(() => {
          connectSocketMode(appToken).catch((err) => {
            console.error(`[Slack] Reconnect failed: ${err instanceof Error ? err.message : err}`);
          });
        }, 5000);
      }
      resolve();
    });

    ws.addEventListener("error", (err) => {
      console.error(`[Slack] Socket Mode error: ${err}`);
      ws.close();
    });
  });
}

async function poll(): Promise<void> {
  const config = getSettings().slack;

  // Identify the bot
  try {
    const auth = await slackApi<SlackAuthTest>(config.botToken, "auth.test");
    if (auth.ok) {
      botUserId = auth.user_id ?? null;
      console.log(`  Bot: ${auth.user ?? botUserId}`);
    }
  } catch (err) {
    console.error(`[Slack] auth.test failed: ${err instanceof Error ? err.message : err}`);
  }

  console.log("Slack bot started (Socket Mode)");
  console.log(`  Allowed channels: ${config.allowedChannelIds.length === 0 ? "all" : config.allowedChannelIds.join(", ")}`);
  if (slackDebug) console.log("  Debug: enabled");

  await connectSocketMode(config.appToken);
}

// --- Exports ---

/** Send a message to a specific channel (used by heartbeat/cron forwarding) */
export { postMessage as sendMessage };

process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });

/** Start Socket Mode in-process (called by start.ts when tokens are configured) */
export function startPolling(debug = false): void {
  slackDebug = debug;
  (async () => {
    await ensureProjectClaudeMd();
    await poll();
  })().catch((err) => {
    console.error(`[Slack] Fatal: ${err}`);
  });
}

/** Standalone entry point (bun run src/index.ts slack) */
export async function slack() {
  await loadSettings();
  await ensureProjectClaudeMd();
  await poll();
}
