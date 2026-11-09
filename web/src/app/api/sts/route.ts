import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";
import { getDataPaths } from "@vargos/lib/paths";
import { MIME_TO_AUDIO_EXT, getMimeTypeFromExt } from "@vargos/lib/mime";
import { rpcCall } from "../../../server/rpc";
import { ensureWsServer } from "../../../server/ws-server";

export const dynamic = "force-dynamic";

/**
 * STS test surface (uncommitted working-tree addition).
 *
 * POST /api/sts — one half-duplex turn:
 *   { audioBase64?, mimeType?, text?, sessionKey? }
 *   → writes audio to <dataDir>/media/sts-inbox/, calls sts.reply over the bus,
 *     returns { replyText, audioPath, duplex, timingMs }.
 *
 * GET /api/sts/audio?path=<basename> — serves a generated TTS file from
 *   <dataDir>/media/tts/ so the page can play the spoken reply.
 */

const TTS_BASENAME = /^tts-[\w.-]+\.(opus|ogg|mp3|wav)$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    audioBase64?: string;
    mimeType?: string;
    text?: string;
    sessionKey?: string;
  };

  const { dataDir } = getDataPaths();

  let audioPath: string | null = null;
  if (body.audioBase64) {
    const ext = MIME_TO_AUDIO_EXT[body.mimeType ?? ""] ?? ".webm";
    const fs = await import("node:fs/promises");
    const inbox = path.join(dataDir, "media", "sts-inbox");
    await fs.mkdir(inbox, { recursive: true });
    audioPath = path.join(inbox, `turn-${Date.now()}${ext}`);
    await fs.writeFile(audioPath, Buffer.from(body.audioBase64!, "base64"));
  }

  if (!audioPath && !body.text) {
    return NextResponse.json({ ok: false, error: "Provide audioBase64 or text" }, { status: 400 });
  }

  await ensureWsServer();

  try {
    const result = await rpcCall<{ replyText: string; audioPath: string; duplex: string; timingMs: { stt: number; agent: number; tts: number } }>(
      "sts.reply",
      {
        input: audioPath ? { audioPath } : { text: body.text },
        sessionKey: body.sessionKey,
      },
    );
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function GET(req: Request) {
  const name = new URL(req.url).searchParams.get("path") ?? "";
  if (!TTS_BASENAME.test(path.basename(name))) {
    return NextResponse.json({ ok: false, error: "invalid path" }, { status: 400 });
  }
  const filePath = path.join(getDataPaths().dataDir, "media", "tts", path.basename(name));
  if (!existsSync(filePath)) {
    return NextResponse.json({ ok: false, error: "file not found" }, { status: 404 });
  }
  const mime = getMimeTypeFromExt(path.extname(filePath).toLowerCase());
  const file = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
  return new Response(new Uint8Array(file), { headers: { "Content-Type": mime } });
}
