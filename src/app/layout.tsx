import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { DESCRIPTION, SITE_NAME, SITE_URL, SOURCE_URL, TAGLINE } from "./site";

/* Archivo: an industrial grotesque with signage heritage — equipment, not
   startup. Plex Mono carries the timecode, where tabular figures matter. */
const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  weight: ["400", "500", "600", "700"],
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  // Absolute URLs for every og:/twitter: tag are resolved from this.
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Cutline — video editor with version control, AI and no sign-up",
    template: "%s — Cutline",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  category: "Multimedia",
  keywords: [
    "video editor",
    "browser video editor",
    "online video editor no sign up",
    "free video editor",
    "open source video editor",
    "video editor with version control",
    "AI video editor",
    "bring your own key",
    "WebCodecs",
    "local-first",
    "silence removal",
  ],
  authors: [{ name: "aviralj02", url: SOURCE_URL }],
  creator: "aviralj02",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: "Cutline — video editor with version control, AI and no sign-up",
    description: TAGLINE,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cutline — video editor with version control, AI and no sign-up",
    description: TAGLINE,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#101010",
  colorScheme: "dark",
};

/**
 * What the page is, in the vocabulary search engines and assistants parse.
 * Only claims the product actually makes: free, no account, browser-only.
 */
const schema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  url: SITE_URL,
  description: DESCRIPTION,
  applicationCategory: "MultimediaApplication",
  applicationSubCategory: "Video Editor",
  operatingSystem: "Any — runs in a web browser",
  browserRequirements: "Requires WebCodecs. Chrome, Edge, or Safari 26 and later.",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  license: "https://opensource.org/licenses/MIT",
  codeRepository: SOURCE_URL,
  author: { "@type": "Person", name: "aviralj02", url: SOURCE_URL },
  featureList: [
    "Cut, trim, reorder and retime clips on a timeline",
    "Fades, punch-in zooms and a sound lane for music",
    "Version control: every change is a restorable version, with variants",
    "Reframe to 9:16, 1:1 or 4:5",
    "Export in the browser through WebCodecs",
    "Optional AI editing on your own API key",
    "No account, no upload and no server",
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>
        <script
          type="application/ld+json"
          // Static, authored above: no user content ever reaches this.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
        />
        {children}
      </body>
    </html>
  );
}
