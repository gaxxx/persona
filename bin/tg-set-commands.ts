#!/usr/bin/env bun
import { callApi } from "./lib/telegram";

const COMMANDS = [
  { command: "stats", description: "查看 daemon 统计 / today's usage" },
];

await callApi("setMyCommands", { commands: COMMANDS });
console.log("registered:");
for (const c of COMMANDS) console.log(`  /${c.command} — ${c.description}`);
