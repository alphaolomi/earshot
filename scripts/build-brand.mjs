// Renders the brand SVGs in brand/ to the PNGs in public/.
// Run after editing a brand file:  npm run brand
// (Outputs are committed, so CI doesn't need the fonts used here.)
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const render = (src, out, width) => {
  const png = new Resvg(readFileSync(`brand/${src}`, "utf8"), {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  }).render().asPng();
  writeFileSync(`public/${out}`, png);
  console.log(`public/${out}  ${width}px  ${(png.length / 1024).toFixed(1)} KB`);
};

render("icon.svg", "icon-192.png", 192);
render("icon.svg", "icon-512.png", 512);
render("icon.svg", "favicon-32.png", 32);
render("icon-maskable.svg", "icon-maskable-512.png", 512);
render("icon-maskable.svg", "apple-touch-icon.png", 180); // iOS rounds the corners itself
render("og-image.svg", "og-image.png", 1200);
copyFileSync("brand/icon.svg", "public/icon.svg");
