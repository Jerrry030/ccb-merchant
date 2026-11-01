import { readFileSync } from "node:fs";
const lines = readFileSync("src/auth.js", "utf8").split(/\r?\n/);
for (let i = 198; i < 220; i++) console.log(String(i + 1).padStart(4), JSON.stringify(lines[i]));
