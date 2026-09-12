import type { MetadataRoute } from "next";
import { SITE_URL } from "./site";

/**
 * One page, one entry. The editor is a single route — every other surface is
 * state inside it, not a URL — and a sitemap that lists routes the app does
 * not serve is worse than no sitemap at all.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
