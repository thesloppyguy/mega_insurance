import { Baloo_2 } from "next/font/google"
import { Toaster } from "sonner"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"

const fontSans = Baloo_2({
  subsets: ["latin"],
  variable: "--font-sans",
  weight: ["400", "500", "600", "700", "800"],
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} font-sans antialiased`}
    >
      <body className="min-h-svh bg-zinc-50 text-zinc-900">
        <ThemeProvider>
          {children}
          <Toaster
            theme="light"
            position="top-center"
            richColors
            closeButton
            toastOptions={{
              className: "font-sans",
            }}
          />
        </ThemeProvider>
      </body>
    </html>
  )
}
