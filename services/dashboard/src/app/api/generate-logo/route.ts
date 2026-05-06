import { NextResponse } from "next/server";
import { removeBackground } from "@/lib/remove-background";
import { extractFaviconFromLogo } from "@/lib/favicon-extractor";

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * POST /api/generate-logo
 * Body: { siteName, vertical, audience? }
 * Returns: { image: string (base64 PNG) } or { error: string }
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not configured" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as {
    siteName: string;
    vertical: string;
    audience?: string;
  };

  const prompt = buildLogoPrompt(body.siteName, body.vertical, body.audience);

  try {
    const url = `${GEMINI_API_BASE}/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });

    if (!response.ok) {
      console.warn(`[generate-logo] Gemini failed: ${response.status}`);
      return NextResponse.json(
        { error: `Gemini returned ${response.status}` },
        { status: 502 }
      );
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content: {
          parts: Array<{
            inlineData?: { mimeType: string; data: string };
            text?: string;
          }>;
        };
      }>;
    };

    const imagePart = data.candidates?.[0]?.content.parts.find(
      (p) => p.inlineData
    );
    if (!imagePart?.inlineData) {
      return NextResponse.json(
        { error: "No image in Gemini response" },
        { status: 502 }
      );
    }

    const raw = Buffer.from(imagePart.inlineData.data, "base64");
    const transparent = await removeBackground(raw);
    // Also extract a square favicon from the logo so the caller gets both
    let faviconBase64: string | undefined;
    try {
      const faviconBuf = await extractFaviconFromLogo(transparent);
      faviconBase64 = faviconBuf.toString("base64");
    } catch {
      // Non-fatal — favicon extraction failed, caller can fall back
    }
    return NextResponse.json({ image: transparent.toString("base64"), favicon: faviconBase64 });
  } catch (err) {
    console.error("[generate-logo] Error:", err);
    return NextResponse.json(
      { error: "Logo generation failed" },
      { status: 500 }
    );
  }
}

function buildLogoPrompt(
  siteName: string,
  vertical: string,
  audience?: string
): string {
  return `Create a modern, professional logo for a website called "${siteName}".
The website is in the "${vertical}" vertical${audience ? ` targeting ${audience}` : ""}.

Requirements:
- Logo must include both an icon/symbol AND the site name "${siteName}" written beside it (horizontal layout: icon on the left, site name text on the right)
- The site name text must be clearly legible, modern sans-serif font, white or light colored
- Simple, clean icon/symbol design paired with the site name
- Works well in a website header
- Modern flat design style with vibrant colors
- Wide/landscape aspect ratio (roughly 3:1 or 4:1 to fit icon + text side by side)
- Professional quality suitable for a content website
- Transparent background (PNG with alpha channel) — do NOT include any background color, the background must be fully transparent`;
}
