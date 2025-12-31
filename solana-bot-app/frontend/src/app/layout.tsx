import type { Metadata } from "next";
import "./globals.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Providers } from "@/components/Providers";
import { Toaster } from "react-hot-toast";

export const metadata: Metadata = {
  title: "Solana Bot App",
  description: "MEV-protected Solana trading bot UI (Jito bundles)"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Toaster
            position="top-right"
            toastOptions={{
              style: { background: "#0b1220", color: "#e2e8f0", border: "1px solid #1e293b" }
            }}
          />
          {children}
        </Providers>
      </body>
    </html>
  );
}

