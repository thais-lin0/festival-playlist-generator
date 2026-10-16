import type { Metadata } from "next";
import { Big_Shoulders, Familjen_Grotesk, Fragment_Mono } from "next/font/google";
import "./globals.css";

const display = Big_Shoulders({ subsets: ["latin"], weight: ["700", "900"], variable: "--font-display" });
const body = Familjen_Grotesk({ subsets: ["latin"], variable: "--font-body" });
const mono = Fragment_Mono({ subsets: ["latin"], weight: "400", variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Line-up → Playlist",
  description: "Envie o line-up. Escolha os artistas. Gere sua playlist no Spotify.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
