// kie.ai remote MCP server for Claude (Streamable HTTP, stateless).
// Endpoints and behavior follow docs.kie.ai as of Oct 2026.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const KIE_API_KEY = process.env.KIE_API_KEY;
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;
const PORT = Number(process.env.PORT || 8080);
const API_BASE = process.env.KIE_API_BASE || "https://api.kie.ai";
const UPLOAD_BASE = process.env.KIE_UPLOAD_BASE || "https://kieai.redpandaai.co";

if (!KIE_API_KEY) throw new Error("KIE_API_KEY is not set");
if (!MCP_PATH_SECRET || MCP_PATH_SECRET.length < 24) {
  throw new Error("MCP_PATH_SECRET must be set and at least 24 characters");
}

// kie returns errors as HTTP 200 with an error code in the body, so always check body.code.
async function kie(base, path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`kie.ai returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.code !== 200) {
    const hint = {
      401: "API key rejected.",
      402: "Insufficient kie.ai credits.",
      422: "Parameter validation failed.",
      429: "Rate limited (20 new tasks per 10 seconds).",
    }[json.code] || "";
    throw new Error(`kie.ai error ${json.code ?? res.status}: ${json.msg || "unknown"} ${hint}`.trim());
  }
  return json.data;
}

function parseTask(d) {
  let result = null;
  try {
    result = d.resultJson ? JSON.parse(d.resultJson) : null;
  } catch {
    result = d.resultJson;
  }
  return {
    taskId: d.taskId,
    model: d.model,
    state: d.state,
    resultUrls: result?.resultUrls ?? null,
    resultObject: result?.resultObject ?? null,
    failCode: d.failCode ?? null,
    failMsg: d.failMsg ?? null,
    costTimeMs: d.costTime ?? null,
    createTime: d.createTime ?? null,
    completeTime: d.completeTime ?? null,
  };
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message || e) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTask(model, input, callBackUrl) {
  const body = { model, input };
  if (callBackUrl) body.callBackUrl = callBackUrl;
  return kie(API_BASE, "/api/v1/jobs/createTask", { method: "POST", body });
}

async function getTask(taskId) {
  return parseTask(await kie(API_BASE, `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`));
}

async function waitTask(taskId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let t = await getTask(taskId);
  while (t.state !== "success" && t.state !== "fail" && Date.now() < deadline) {
    await sleep(5000);
    t = await getTask(taskId);
  }
  return t;
}

const NOTES =
  "Generated media is kept by kie.ai for 14 days; uploaded inputs are deleted after 24 hours. Download anything worth keeping.";

function buildServer() {
  const server = new McpServer(
    { name: "kie-ai", version: "1.0.0" },
    {
      instructions:
        "kie.ai media generation. Generation is async: create a task, then call kie_wait_for_task " +
        "(repeat if it returns a non-final state) or kie_get_task. Inputs must be public URLs; for local " +
        "files use kie_upload_base64 or kie_upload_from_url first and pass the returned downloadUrl. " +
        "Generating spends kie.ai credits: never resubmit a create call to retry, check the existing task. " +
        "For any model other than Seedance 2.5, read its page at https://docs.kie.ai for the exact model id " +
        "and input fields before calling kie_create_task. " + NOTES,
    }
  );

  server.registerTool(
    "seedance_2_5_generate",
    {
      title: "Seedance 2.5 video",
      description:
        "Create a ByteDance Seedance 2.5 video task on kie.ai (model bytedance/seedance-2-5). Returns a taskId; " +
        "then call kie_wait_for_task. Reference media must be public URLs. Reference videos combined must be " +
        "30 seconds or less, reference audio combined 30 seconds or less. In the prompt, refer to references " +
        "as @Image1, @Image2, and so on. Spends credits.",
      inputSchema: {
        prompt: z.string().max(20480).describe("What to generate."),
        first_frame_url: z.string().url().optional(),
        last_frame_url: z.string().url().optional(),
        reference_image_urls: z.array(z.string().url()).optional().describe("jpeg/png/webp, up to 30MB each"),
        reference_video_urls: z.array(z.string().url()).optional().describe("mp4/mov/mkv, up to 200MB each"),
        reference_audio_urls: z.array(z.string().url()).optional().describe("mp3/wav/aac/ogg, up to 15MB each"),
        resolution: z.enum(["480p", "720p", "1080p"]).optional().describe("Default 720p"),
        aspect_ratio: z.enum(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]).optional().describe("Default adaptive"),
        duration: z.number().int().min(-1).max(30).optional().describe("Seconds, default 5. kie lists -1 to 30."),
        generate_audio: z.boolean().optional().describe("Default true"),
        return_last_frame: z.boolean().optional(),
        output_format: z.enum(["mp4", "mov"]).optional().describe("Default mp4"),
        web_search: z.boolean().optional().describe("Default false"),
        draft: z.boolean().optional().describe("Cheap 480p preview. Draft task ID valid 7 days."),
        nsfw_checker: z.boolean().optional().describe("Default true"),
        callBackUrl: z.string().url().optional(),
      },
    },
    async ({ callBackUrl, ...input }) => {
      try {
        const clean = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
        const data = await createTask("bytedance/seedance-2-5", clean, callBackUrl);
        return ok({ taskId: data.taskId, next: "Call kie_wait_for_task with this taskId." });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_create_task",
    {
      title: "Create any kie.ai task",
      description:
        "Create a generation task for any kie.ai Market model through POST /api/v1/jobs/createTask. " +
        "Pass the exact model id (for example bytedance/seedance-2-5) and its input object as documented " +
        "on that model's docs.kie.ai page. Some older models (Veo3.1, Suno, Runway, 4o Image, Flux Kontext) " +
        "use their own endpoints and are not supported here. Spends credits.",
      inputSchema: {
        model: z.string().describe("Exact kie.ai model id"),
        input: z.record(z.string(), z.any()).describe("Model input object"),
        callBackUrl: z.string().url().optional(),
      },
    },
    async ({ model, input, callBackUrl }) => {
      try {
        const data = await createTask(model, input, callBackUrl);
        return ok({ taskId: data.taskId, next: "Call kie_wait_for_task with this taskId." });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_get_task",
    {
      title: "Get task status",
      description: "Check a kie.ai task once. state is waiting, success, or fail; resultUrls holds outputs on success.",
      inputSchema: { taskId: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      try {
        return ok({ ...(await getTask(taskId)), note: NOTES });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_wait_for_task",
    {
      title: "Wait for task",
      description:
        "Poll a kie.ai task every 5 seconds until it finishes or the timeout passes, then return its status. " +
        "Video often takes several minutes: if the state is still waiting, call again with the same taskId.",
      inputSchema: {
        taskId: z.string(),
        timeout_seconds: z.number().int().min(5).max(55).optional().describe("Default 50"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, timeout_seconds }) => {
      try {
        const t = await waitTask(taskId, timeout_seconds ?? 50);
        return ok({ ...t, final: t.state === "success" || t.state === "fail", note: NOTES });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_upload_from_url",
    {
      title: "Upload file from URL",
      description:
        "Copy a public file (image, video, audio) onto kie.ai storage and return a downloadUrl to use as a model input. " +
        "30 second download timeout, about 100MB max. Uploads are free and deleted after 24 hours.",
      inputSchema: { fileUrl: z.string().url(), fileName: z.string().optional() },
    },
    async ({ fileUrl, fileName }) => {
      try {
        const data = await kie(UPLOAD_BASE, "/api/file-url-upload", {
          method: "POST",
          body: { fileUrl, uploadPath: "claude", ...(fileName ? { fileName } : {}) },
        });
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_upload_base64",
    {
      title: "Upload file as base64",
      description:
        "Upload a small file (10MB or less recommended) as base64 or a data URL (data:image/png;base64,...) " +
        "and return a downloadUrl to use as a model input. Uploads are free and deleted after 24 hours.",
      inputSchema: {
        base64Data: z.string().describe("Plain base64 or a data URL"),
        fileName: z.string().optional().describe("Include the extension when passing plain base64"),
      },
    },
    async ({ base64Data, fileName }) => {
      try {
        const data = await kie(UPLOAD_BASE, "/api/file-base64-upload", {
          method: "POST",
          body: { base64Data, uploadPath: "claude", ...(fileName ? { fileName } : {}) },
        });
        return ok(data);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_get_credits",
    {
      title: "Credit balance",
      description: "Return the kie.ai account's remaining credits.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok({ credits: await kie(API_BASE, "/api/v1/chat/credit") });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "kie_get_download_url",
    {
      title: "Get download link",
      description:
        "Turn a kie.ai generated result URL into a temporary download link valid for 20 minutes. " +
        "Only works on task result URLs, not uploaded files.",
      inputSchema: { url: z.string().url() },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      try {
        return ok({ downloadUrl: await kie(API_BASE, "/api/v1/common/download-url", { method: "POST", body: { url } }) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

const mcpPath = `/mcp/${MCP_PATH_SECRET}`;

app.post(mcpPath, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get(mcpPath, notAllowed);
app.delete(mcpPath, notAllowed);

app.use((_req, res) => res.status(404).end());

app.listen(PORT, "0.0.0.0", () => console.log(`kie-mcp listening on ${PORT}`));
