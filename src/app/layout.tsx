import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BIFROST // QUANT_ENGINE",
  description: "Institutional SMC Algorithmic Trading Terminal",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-[#020617] text-slate-100 font-sans">
        {children}
      </body>
    </html>
  );
}
