import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cutline — agentic video editing",
  description: "A browser video editor where the edit is a document, the agent edits it, and every change is a version.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
