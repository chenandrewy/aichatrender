#!/usr/bin/env node
// Run: npm run export-transcript -- [--provider auto|claude|codex] [--force]
//      <input.jsonl> <output.md>
// Input: one local Claude Code or Codex CLI JSONL transcript.
// Output: a readable Markdown copy containing the messages AIChatRender displays.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript, renderMarkdown } = require('../export');

function usage() {
  return [
    'Usage: export-transcript [--provider auto|claude|codex] [--force] <input.jsonl> <output.md>',
    '',
    'Exports all user and assistant messages that AIChatRender would display.',
    'The output file is created exclusively unless --force is supplied.',
  ].join('\n');
}

function parseArgs(argv) {
  let provider = 'auto';
  let force = false;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--provider') {
      provider = argv[++i];
      if (!provider) throw new Error('--provider requires a value.');
    } else if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) throw new Error('Expected an input JSONL and output Markdown path.');
  return { provider, force, inputPath: positional[0], outputPath: positional[1] };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  try {
    const inputPath = path.resolve(args.inputPath);
    const outputPath = path.resolve(args.outputPath);
    const raw = fs.readFileSync(inputPath, 'utf8');
    const transcript = parseTranscript(raw, { provider: args.provider, inputPath });
    const markdown = renderMarkdown(transcript, { inputPath });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, markdown, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
    const providerLabel = transcript.provider === 'codex' ? 'Codex' : 'Claude';
    console.log(
      `Exported ${providerLabel} transcript: ${transcript.turns} turns, ` +
        `${transcript.messages.length} displayable messages -> ${outputPath}`,
    );
    return 0;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      console.error(`Output already exists: ${path.resolve(args.outputPath)} (use --force to replace it)`);
    } else {
      console.error(error.message);
    }
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs, usage };
