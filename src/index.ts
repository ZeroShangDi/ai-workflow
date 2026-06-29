#!/usr/bin/env node

import { runInstall } from "./commands/install";
import { runUninstall } from "./commands/uninstall";

function printBanner(): void {
  console.log("");
  console.log("  ========================================");
  console.log("  |  ai-workflow - Claude Code Plugin     |");
  console.log("  ========================================");
  console.log("");
}

function printHelp(): void {
  console.log("  Usage:");
  console.log("    ai-workflow install      Install plugin to Claude Code");
  console.log("    ai-workflow uninstall    Remove plugin from Claude Code");
  console.log("    ai-workflow --help       Show this help");
  console.log("    ai-workflow --version    Show version");
  console.log("");
}

const command = process.argv[2];

if (command === "--help" || command === "-h") {
  printBanner();
  printHelp();
} else if (command === "--version" || command === "-v") {
  const pkg = require("../package.json");
  console.log(pkg.version);
} else if (command === "install") {
  printBanner();
  runInstall();
} else if (command === "uninstall") {
  printBanner();
  runUninstall();
} else {
  printBanner();
  console.log("  Unknown command: " + (command || "(empty)"));
  console.log("");
  printHelp();
  process.exit(1);
}
