import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

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
  title: "Cutline — video editor with version control, AI and no sign-up",
  description:
    "Edit video in your browser. Cut by hand, go back to any version, and use AI on your own key when you want it. No account, no upload, no server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
