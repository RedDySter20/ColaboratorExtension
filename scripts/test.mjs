#!/usr/bin/env node
/**
 * Version-independent test runner.
 *
 * `node --test --test-isolation=none "tests/*.test.js"` works on Node 24+, but
 * older Node versions reject `--test-isolation` and some shells do not expand the
 * glob, which broke CI. Importing the test files into one process gives the same
 * behaviour on every supported Node release (>= 20) and still uses the official
 * `node:test` reporter and exit codes.
 *
 *   node scripts/test.mjs                 # all tests
 *   node scripts/test.mjs repository      # only files matching "repository"
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");
const filter = process.argv[2] ?? "";

const files = fs
  .readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.js"))
  .filter((name) => (filter ? name.includes(filter) : true))
  .sort();

if (files.length === 0) {
  console.error(filter ? `No test files match "${filter}"` : "No test files found");
  process.exit(1);
}

for (const file of files) {
  process.stdout.write(`\n# ${file}\n`);
  await import(pathToFileURL(path.join(testsDir, file)).href);
}
