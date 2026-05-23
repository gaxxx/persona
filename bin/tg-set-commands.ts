#!/usr/bin/env bun
import { callApi } from "./lib/telegram";
import { loadMembers, getAdmin } from "./lib/members";

const GENERAL_COMMANDS = [
  { command: "stats", description: "查看 daemon 统计 / today's usage" },
];

const ADMIN_COMMANDS = [
  ...GENERAL_COMMANDS,
  { command: "list_members", description: "List all members and quota usage" },
  { command: "quota", description: "Check a member's quota: /quota alex" },
  { command: "reset_quota", description: "Reset a member's daily quota: /reset_quota alex" },
];

// Register general commands for all chats
await callApi("setMyCommands", {
  commands: GENERAL_COMMANDS,
  scope: { type: "default" },
});
console.log("registered general commands:");
for (const c of GENERAL_COMMANDS) console.log(`  /${c.command} — ${c.description}`);

// Register admin commands scoped to admin's chat_id
const members = loadMembers();
const admin = getAdmin(members);
if (admin) {
  await callApi("setMyCommands", {
    commands: ADMIN_COMMANDS,
    scope: { type: "chat", chat_id: admin.telegram_chat_id },
  });
  console.log(`\nregistered admin commands for chat_id ${admin.telegram_chat_id}:`);
  for (const c of ADMIN_COMMANDS) console.log(`  /${c.command} — ${c.description}`);
} else {
  console.log("\nNo admin.md found — skipping admin-scoped commands.");
}
