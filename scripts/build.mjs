#!/usr/bin/env node
/**
 * Build the loadable extension.
 *
 *   node scripts/build.mjs          → dist/ (unpacked extension)
 *   node scripts/build.mjs --zip    → dist/ + release/ColaboratorExtension-v<version>.zip
 *
 * The build is intentionally simple: MV3 loads plain ES modules, so "building"
 * means copying `src/` and validating that everything the manifest and the module
 * graph reference actually exists.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip, listFiles } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");
const releaseDir = path.join(root, "release");
const wantZip = process.argv.includes("--zip");

const problems = [];
const note = (message) => problems.push(message);

/* ------------------------------------------------------------------ helpers */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

function readManifest() {
  const manifestPath = path.join(srcDir, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`manifest.json is not valid JSON: ${error.message}`);
  }
}

/* --------------------------------------------------------------- validation */

function validateManifest(manifest) {
  const required = ["manifest_version", "name", "version", "description", "background", "action"];
  for (const key of required) {
    if (!manifest[key]) note(`manifest.json: missing "${key}"`);
  }
  if (manifest.manifest_version !== 3) note("manifest.json: manifest_version must be 3");

  const referenced = new Set();
  const add = (value) => {
    if (typeof value === "string") referenced.add(value);
  };
  if (manifest.background?.service_worker) add(manifest.background.service_worker);
  if (manifest.action?.default_popup) add(manifest.action.default_popup);
  if (manifest.options_ui?.page) add(manifest.options_ui.page);
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) add(icon);

  for (const relative of referenced) {
    if (!fs.existsSync(path.join(srcDir, relative))) {
      note(`manifest references a missing file: ${relative}`);
    }
  }

  // Icons must be PNG (Chrome rejects SVG icons in the manifest).
  for (const relative of referenced) {
    if (relative.startsWith("icons/") && path.extname(relative) !== ".png") {
      note(`icon must be a PNG: ${relative}`);
    }
  }

  // Every HTML page must load existing local assets.
  const htmlFiles = listFiles(srcDir).filter((file) => file.rel.endsWith(".html"));
  for (const html of htmlFiles) {
    const markup = fs.readFileSync(html.abs, "utf8");
    const attributes = [...markup.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    for (const value of attributes) {
      if (/^(https?:|data:|#|mailto:)/.test(value)) continue;
      const target = path.resolve(path.dirname(html.abs), value);
      if (!fs.existsSync(target)) note(`${html.rel}: broken reference to ${value}`);
    }
  }
}

function validateModuleGraph() {
  const jsFiles = listFiles(srcDir).filter((file) => file.rel.endsWith(".js"));
  for (const file of jsFiles) {
    const source = fs.readFileSync(file.abs, "utf8");
    for (const match of source.matchAll(/(?:import|export)[^"'`]*?from\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        note(`${file.rel}: bare module specifier "${specifier}" (MV3 cannot resolve it)`);
        continue;
      }
      const target = path.resolve(path.dirname(file.abs), specifier);
      if (!fs.existsSync(target)) note(`${file.rel}: import not found → ${specifier}`);
    }
  }
}

/* -------------------------------------------------------------------- build */

const manifest = readManifest();
validateManifest(manifest);
validateModuleGraph();

if (problems.length) {
  console.error("✖ Build failed:\n" + problems.map((problem) => `  - ${problem}`).join("\n"));
  process.exit(1);
}

fs.rmSync(distDir, { recursive: true, force: true });
copyDir(srcDir, distDir);
console.log(`✔ dist/ ready (v${manifest.version}, ${listFiles(distDir).length} files)`);

if (wantZip) {
  fs.mkdirSync(releaseDir, { recursive: true });
  const zipName = `ColaboratorExtension-v${manifest.version}.zip`;
  const zipPath = path.join(releaseDir, zipName);
  const files = listFiles(distDir);
  fs.writeFileSync(zipPath, createZip(files, "ColaboratorExtension"));
  const size = (fs.statSync(zipPath).size / 1024).toFixed(1);
  console.log(`✔ release/${zipName} (${size} KB)`);
}
