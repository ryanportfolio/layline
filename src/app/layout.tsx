import type { Metadata, Viewport } from "next";
import { Archivo, Martian_Mono } from "next/font/google";
import "./globals.css";

/* Self-hosted at build by Next, no runtime CDN. Archivo carries the width axis
 * so the wordmark can letter in expanded caps; Martian Mono is the instrument
 * voice: every number on the HUD sets in it. */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const martian = Martian_Mono({
  subsets: ["latin"],
  variable: "--font-martian",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Layline · Race Replay",
  description:
    "Browser race replay engine for a fictional Long Beach fleet race: continuous 3D motion rebuilt from four fixes a second of boat telemetry.",
};

export const viewport: Viewport = {
  themeColor: "#070f16",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`}>
      <body>{children}</body>
    </html>
  );
}
