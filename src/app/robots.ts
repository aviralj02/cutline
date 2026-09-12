import type { MetadataRoute } from "next";
import { SITE_URL } from "./site";

/**
 * Everything here is public: one page, no accounts, no user content, and the
 * footage never reaches a server to be crawled in the first place.
 *
 * The AI crawlers are named rather than left to the wildcard on purpose. Some
 * of them treat an explicit allow differently from a bare `*`, and this
 * project wants to be read by them — being quotable by an assistant is how a
 * tool like this gets found now.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      {
        userAgent: [
          "GPTBot",
          "OAI-SearchBot",
          "ChatGPT-User",
          "ClaudeBot",
          "Claude-User",
          "Claude-SearchBot",
          "PerplexityBot",
          "Perplexity-User",
          "Google-Extended",
          "Applebot",
          "Applebot-Extended",
          "Amazonbot",
          "meta-externalagent",
          "cohere-ai",
          "CCBot",
        ],
        allow: "/",
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
