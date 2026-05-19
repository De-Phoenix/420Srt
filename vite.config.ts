import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom plugin: removes crossorigin + copies dist to ./deploy folder
function deployPlugin(): Plugin {
  return {
    name: "deploy-plugin",
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(__dirname, "dist");
      const deployDir = path.resolve(__dirname, "deploy");

      // Recursively copy dist → deploy
      function copyDir(src: string, dest: string) {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
          } else {
            let content = fs.readFileSync(srcPath, "utf-8");
            // Remove crossorigin attributes from script/link tags
            if (entry.name.endsWith(".html")) {
              content = content.replace(/\s+crossorigin(?=\s|>)/g, "");
            }
            fs.writeFileSync(destPath, content);
          }
        }
      }

      if (fs.existsSync(distDir)) {
        copyDir(distDir, deployDir);
        console.log("✅ Copied dist → deploy/ (crossorigin removed)");
      }
    },
    transformIndexHtml(html) {
      // Remove crossorigin from all script/link tags in final HTML
      return html.replace(/\s+crossorigin(?=\s|>)/g, "");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), deployPlugin()],
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
