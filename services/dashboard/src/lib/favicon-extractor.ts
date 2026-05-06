import sharp from "sharp";

/**
 * Extract a square favicon from a landscape logo image.
 *
 * AI-generated logos are ~800x200 (4:1), laid out as [icon | site name text].
 * This function crops the leftmost square (height x height) to isolate the
 * icon, then resizes to 180x180 (covers apple-touch-icon; browsers downscale
 * for 16/32 tabs). For square or portrait images, the full image is resized.
 *
 * Returns a PNG buffer suitable for saving as favicon.png.
 */
export async function extractFaviconFromLogo(
  logoBuffer: Buffer,
): Promise<Buffer> {
  const meta = await sharp(logoBuffer).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;

  if (w === 0 || h === 0) {
    // Can't parse — fall back to resizing the whole image
    return sharp(logoBuffer).resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  }

  // Only crop if the image is significantly wider than tall (landscape logo)
  if (w > h * 1.5) {
    // Crop the leftmost square — that's where the icon lives
    const size = h;
    return sharp(logoBuffer)
      .extract({ left: 0, top: 0, width: size, height: size })
      .resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  }

  // Square-ish or portrait — just resize the whole thing
  return sharp(logoBuffer)
    .resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}
