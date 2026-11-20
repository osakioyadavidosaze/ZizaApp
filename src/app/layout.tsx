import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ziza — private chats, closer connections",
  description: "A private, real-time messenger powered by your Ziza Number.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
