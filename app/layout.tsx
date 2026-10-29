import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Watchtower",
  description: "Incident monitor for Plate & Pace",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
