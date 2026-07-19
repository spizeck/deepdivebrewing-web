import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PHOTO_DIR = path.join(__dirname, "..", "public", "photos");
const OG_PATH = path.join(PHOTO_DIR, "og-default.jpg");
const HERO_PATH = path.join(PHOTO_DIR, "herograin.jpg");
const OPTIMIZED_HERO_PATH = HERO_PATH.replace(".jpg", "-optimized.jpg");

const hero = sharp(HERO_PATH);
const meta = await hero.metadata();

// Recompress hero at 1920px wide, quality 75, progressive scan.
await hero
  .resize(1920, undefined, { withoutEnlargement: true })
  .jpeg({ quality: 75, progressive: true, mozjpeg: true })
  .toFile(OPTIMIZED_HERO_PATH);

// 1200x630 OpenGraph crop from center.
await sharp(HERO_PATH)
  .resize(1200, 630, { fit: "cover", position: "centre" })
  .jpeg({ quality: 85, progressive: true, mozjpeg: true })
  .toFile(OG_PATH);

const optimizedStats = fs.statSync(OPTIMIZED_HERO_PATH);
const ogStats = fs.statSync(OG_PATH);

console.log(
  `Original hero: ${meta.width}x${meta.height} ~${(
    fs.statSync(HERO_PATH).size / 1024 / 1024
  ).toFixed(2)} MB`
);
console.log(
  `Optimized hero: ${optimizedStats ? (optimizedStats.size / 1024).toFixed(1) : "unknown"} KB`
);
console.log(`OG image: ${(ogStats.size / 1024).toFixed(1)} KB`);
