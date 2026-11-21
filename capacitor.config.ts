import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.zizaapp.app",
  appName: "ZizaApp",
  webDir: "www",
  backgroundColor: "#101728",
  server: {
    url: "https://zizaapp.vercel.app",
    allowNavigation: ["*.supabase.co"],
  },
  plugins: {
    SystemBars: {
      insetsHandling: "css",
      initialViewportFitValueHint: "cover",
    },
  },
};

export default config;
