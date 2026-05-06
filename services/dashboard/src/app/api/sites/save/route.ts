import { NextRequest, NextResponse } from "next/server";
import { stringify as stringifyYaml } from "yaml";
import {
  commitSiteFiles,
  readDashboardIndex,
  readSiteConfig as readSiteConfigFromGit,
  triggerWorkflowViaPush,
} from "@/lib/github";
import type { StagingSiteConfig } from "@/actions/wizard";
import { extractFaviconFromLogo } from "@/lib/favicon-extractor";

interface SaveRequestBody {
  domain: string;
  configUpdates: Partial<StagingSiteConfig> | null;
  logoBase64: string | null;
  faviconBase64: string | null;
}

/**
 * Route Handler for saving staging edits.
 * Uses a plain HTTP response instead of RSC flight protocol,
 * avoiding the "Maximum array nesting exceeded" error that occurs
 * when Next.js bundles the full page RSC tree into server action responses.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: SaveRequestBody;
  try {
    body = (await req.json()) as SaveRequestBody;
  } catch {
    return NextResponse.json(
      { status: "error", message: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { domain, configUpdates, logoBase64, faviconBase64 } = body;

  if (!domain) {
    return NextResponse.json(
      { status: "error", message: "domain is required" },
      { status: 400 }
    );
  }

  try {
    const index = await readDashboardIndex();
    const site = index.sites.find((s) => s.domain === domain);
    if (!site?.staging_branch) {
      return NextResponse.json(
        { status: "error", message: "No staging branch for this site" },
        { status: 400 }
      );
    }

    const existing = await readSiteConfigFromGit(domain, site.staging_branch);
    if (!existing) {
      return NextResponse.json(
        { status: "error", message: "Could not read site config from staging branch" },
        { status: 400 }
      );
    }

    // Apply config updates if provided
    if (configUpdates) {
      if (configUpdates.siteName !== undefined) existing.site_name = configUpdates.siteName;
      if (configUpdates.siteTagline !== undefined) existing.site_tagline = configUpdates.siteTagline || null;

      const brief = (existing.brief ?? {}) as Record<string, unknown>;
      if (configUpdates.audiences !== undefined) brief.audiences = configUpdates.audiences;
      if (configUpdates.audienceIds !== undefined) brief.audience_type_ids = configUpdates.audienceIds;
      if (configUpdates.tone !== undefined) brief.tone = configUpdates.tone;
      if (configUpdates.topics !== undefined) brief.topics = configUpdates.topics;
      if (configUpdates.contentGuidelines !== undefined) {
        brief.content_guidelines = configUpdates.contentGuidelines
          ? configUpdates.contentGuidelines.split("\n").filter(Boolean)
          : [];
      }

      const schedule = (brief.schedule ?? {}) as Record<string, unknown>;
      if (configUpdates.articlesPerDay !== undefined) {
        schedule.articles_per_day = configUpdates.articlesPerDay;
        delete schedule.articles_per_week;
      }
      if (configUpdates.preferredDays !== undefined) schedule.preferred_days = configUpdates.preferredDays;
      brief.schedule = schedule;
      existing.brief = brief;

      if (configUpdates.themeBase !== undefined) {
        const theme = (existing.theme ?? {}) as Record<string, unknown>;
        theme.base = configUpdates.themeBase;
        existing.theme = theme;
      }
      if (configUpdates.theme_colors !== undefined) {
        const theme = (existing.theme ?? {}) as Record<string, unknown>;
        theme.colors = configUpdates.theme_colors;
        existing.theme = theme;
      }
      if (configUpdates.theme_fonts !== undefined) {
        const theme = (existing.theme ?? {}) as Record<string, unknown>;
        theme.fonts = configUpdates.theme_fonts;
        existing.theme = theme;
      }
      if (configUpdates.layout !== undefined) {
        existing.layout = configUpdates.layout;
      }

      // Phase 1 config fields
      if (configUpdates.groups !== undefined) {
        existing.groups = configUpdates.groups;
      }
      if (configUpdates.tracking !== undefined) {
        const prev = (existing.tracking ?? {}) as Record<string, unknown>;
        existing.tracking = { ...prev, ...configUpdates.tracking };
      }
      if (configUpdates.scripts !== undefined) {
        // Only persist non-empty position arrays. Empty arrays mean "no
        // site-level override" and should not be written — they would
        // shadow inherited scripts from org/group/override layers during
        // the merge-by-id resolution in seed-kv.
        const scripts = configUpdates.scripts as Record<string, unknown[]>;
        const filtered: Record<string, unknown[]> = {};
        for (const [pos, entries] of Object.entries(scripts)) {
          if (Array.isArray(entries) && entries.length > 0) {
            filtered[pos] = entries;
          }
        }
        if (Object.keys(filtered).length > 0) {
          existing.scripts = filtered;
        } else {
          delete (existing as Record<string, unknown>).scripts;
        }
      }
      if (configUpdates.scripts_vars !== undefined) {
        const prev = (existing.scripts_vars ?? {}) as Record<string, string>;
        existing.scripts_vars = { ...prev, ...configUpdates.scripts_vars };
      }
      if (configUpdates.ads_config !== undefined) {
        const prev = (existing.ads_config ?? {}) as Record<string, unknown>;
        const merged = { ...prev, ...configUpdates.ads_config } as Record<string, unknown>;
        // Don't persist an empty ad_placements array — it shadows inherited
        // placements from org/group/override layers during deepMerge in
        // seed-kv. Same rationale as the scripts filter above.
        const placements = merged.ad_placements;
        if (Array.isArray(placements) && placements.length === 0) {
          delete merged.ad_placements;
        }
        existing.ads_config = merged;
      }
      // merge_modes is a feature-branch directive — the main-branch
      // seed-kv.ts ignores it. Don't persist until it ships on main.
      // if (configUpdates.merge_modes !== undefined) {
      //   existing.merge_modes = configUpdates.merge_modes;
      // }
      if (configUpdates.quality_threshold !== undefined) {
        brief.quality_threshold = configUpdates.quality_threshold;
      }
      if (configUpdates.quality_weights !== undefined) {
        brief.quality_weights = configUpdates.quality_weights;
      }

      // Niche targeting fields
      if (configUpdates.verticalId !== undefined) brief.vertical_id = configUpdates.verticalId;
      if (configUpdates.vertical !== undefined) brief.vertical = configUpdates.vertical;
      if (configUpdates.categoryIds !== undefined) brief.category_ids = configUpdates.categoryIds;
      if (configUpdates.tagIds !== undefined) brief.tag_ids = configUpdates.tagIds;
      if (configUpdates.seoKeywords !== undefined) brief.seo_keywords_focus = configUpdates.seoKeywords;
      if (configUpdates.bundleId !== undefined) {
        (existing as Record<string, unknown>).bundle_id = configUpdates.bundleId || undefined;
      }
    }

    // Set theme references for logo/favicon
    // When a logo is provided without a separate favicon, auto-extract the
    // icon portion as a square favicon so the browser tab is recognizable.
    let effectiveFaviconBase64 = faviconBase64;
    if (logoBase64 && !faviconBase64) {
      try {
        const extracted = await extractFaviconFromLogo(Buffer.from(logoBase64, "base64"));
        effectiveFaviconBase64 = extracted.toString("base64");
      } catch {
        // Fall back to using the full logo as favicon
        effectiveFaviconBase64 = logoBase64;
      }
    }

    if (logoBase64 || effectiveFaviconBase64) {
      const theme = (existing.theme ?? {}) as Record<string, unknown>;
      if (logoBase64) {
        theme.logo = "/assets/logo.png";
      }
      if (effectiveFaviconBase64) {
        theme.favicon = "/assets/favicon.png";
      }
      existing.theme = theme;
    }

    // Build the file list — single commit for everything
    const files: Array<{ path: string; content: string | Buffer }> = [
      {
        path: `sites/${domain}/site.yaml`,
        content: stringifyYaml(existing, { lineWidth: 0 }),
      },
    ];

    if (logoBase64) {
      files.push({
        path: `sites/${domain}/assets/logo.png`,
        content: Buffer.from(logoBase64, "base64"),
      });
    }
    if (effectiveFaviconBase64) {
      files.push({
        path: `sites/${domain}/assets/favicon.png`,
        content: Buffer.from(effectiveFaviconBase64, "base64"),
      });
    }

    const hasAssets = logoBase64 || effectiveFaviconBase64;
    const assetLabel = logoBase64 && effectiveFaviconBase64
      ? "logo and favicon"
      : logoBase64
        ? "logo"
        : "favicon";
    const commitMsg = hasAssets && configUpdates
      ? `update site config and ${assetLabel}`
      : hasAssets
        ? `update ${assetLabel}`
        : "update site config";

    await commitSiteFiles(domain, files, commitMsg, site.staging_branch);
    await triggerWorkflowViaPush(site.staging_branch, domain);

    return NextResponse.json({ status: "ok" });
  } catch (err) {
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
