#!/usr/bin/env node
'use strict';
// Copies this skill folder to ~/.claude/skills/token-router so Claude Code loads it in new sessions.
const fs = require('fs');
const os = require('os');
const path = require('path');

const dest = path.join(os.homedir(), '.claude', 'skills', 'token-router');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(__dirname, 'SKILL.md'), path.join(dest, 'SKILL.md'));
fs.cpSync(path.join(__dirname, 'scripts'), path.join(dest, 'scripts'), { recursive: true });
console.log(`installed: ${dest}`);
