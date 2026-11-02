import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Interview Ready — Practice with purpose",
  description: "A voice-first interview practice studio tailored to your experience and target role."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
