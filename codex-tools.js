// Safe normalization for Codex CLI tool records. Wrapper source is parsed as
// JavaScript syntax only: no expression from a rollout is evaluated or called.
'use strict';

// The extension ships Acorn as an npm dependency. The browser viewer
// (chatview/) runs from a plain checkout without `npm install`, so it falls
// back to the ES module source under vendor/, which needs Node 22.12+.
function requireDependency(name) {
  try {
    return require(name);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return require('./vendor/' + name + '/index.js');
  }
}

const acorn = requireDependency('acorn');
const walk = requireDependency('acorn-walk');

const CODEX_TOOL_LIMITS = {
  MAX_EXEC_SOURCE: 192 * 1024,
  MAX_AST_NODES: 20000,
  MAX_STATIC_DEPTH: 32,
  MAX_STATIC_NODES: 4096,
  MAX_CALLS_PER_EXEC: 64,
  MAX_PENDING: 512,
};

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function redactImageData(text) {
  return typeof text === 'string'
    ? text.replace(/data:image\/[^\s"'<>)]*/gi, '[image]')
    : '';
}

function displayNameForTool(rawName, input = {}) {
  const aliases = {
    apply_patch: 'Edit',
    exec_command: 'Bash',
    update_plan: 'UpdatePlan',
    view_image: 'ViewImage',
    wait: 'Wait',
    write_stdin: 'BashOutput',
  };
  if (aliases[rawName]) return aliases[rawName];
  if (rawName === 'web__run') return typeof input.query === 'string' ? 'WebSearch' : 'Web';
  if (/^(?:image_gen|image_generation)(?:__|$)/.test(rawName)) return 'ImageGeneration';
  if (rawName.startsWith('mcp__')) {
    const parts = rawName.split('__').filter(Boolean);
    if (parts.length >= 3) return `${parts[1]}.${parts.slice(2).join('.')}`;
  }
  return rawName || 'Tool';
}

function firstWebQuery(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== 'object') return '';
  if (typeof value.q === 'string' && value.q.trim() !== '') return value.q;
  if (typeof value.query === 'string' && value.query.trim() !== '') return value.query;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 8)) {
      const found = firstWebQuery(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  for (const item of Object.values(value).slice(0, 16)) {
    const found = firstWebQuery(item, depth + 1);
    if (found) return found;
  }
  return '';
}

function normalizedInput(rawName, values) {
  let input;
  if (values.length === 1 && values[0] && typeof values[0] === 'object' && !Array.isArray(values[0])) {
    input = values[0];
  } else if (values.length === 1) {
    const key = rawName === 'apply_patch' ? 'patch' : 'value';
    input = { [key]: values[0] };
  } else {
    input = {};
    values.forEach((value, index) => {
      input[`arg${index + 1}`] = value;
    });
  }
  if (rawName === 'web__run' && typeof input.query !== 'string') {
    const query = firstWebQuery(input);
    if (query) input = { ...input, query };
  }
  return input;
}

function propertyName(property) {
  if (property.computed || property.kind !== 'init' || property.method) return undefined;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
    return property.key.value;
  }
  return undefined;
}

function safeStaticValue(node, bindings, state, depth = 0) {
  state.nodes += 1;
  if (
    !node ||
    depth > CODEX_TOOL_LIMITS.MAX_STATIC_DEPTH ||
    state.nodes > CODEX_TOOL_LIMITS.MAX_STATIC_NODES
  ) {
    return { ok: false };
  }
  if (node.type === 'Literal') {
    if (
      node.value === null ||
      typeof node.value === 'string' ||
      typeof node.value === 'boolean' ||
      (typeof node.value === 'number' && Number.isFinite(node.value))
    ) {
      return { ok: true, value: node.value };
    }
    return { ok: false };
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length !== 0 || node.quasis.length !== 1) return { ok: false };
    return { ok: true, value: node.quasis[0].value.cooked ?? node.quasis[0].value.raw };
  }
  if (node.type === 'Identifier') {
    return bindings.has(node.name) ? { ok: true, value: bindings.get(node.name) } : { ok: false };
  }
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const inner = safeStaticValue(node.argument, bindings, state, depth + 1);
    if (!inner.ok || typeof inner.value !== 'number') return { ok: false };
    const value = node.operator === '-' ? -inner.value : inner.value;
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (node.type === 'ArrayExpression') {
    const value = [];
    for (const element of node.elements) {
      if (!element || element.type === 'SpreadElement') return { ok: false };
      const item = safeStaticValue(element, bindings, state, depth + 1);
      if (!item.ok) return { ok: false };
      value.push(item.value);
    }
    return { ok: true, value };
  }
  if (node.type === 'ObjectExpression') {
    const value = {};
    for (const property of node.properties) {
      if (!property || property.type !== 'Property') return { ok: false };
      const key = propertyName(property);
      if (!key || UNSAFE_KEYS.has(key)) return { ok: false };
      const item = safeStaticValue(property.value, bindings, state, depth + 1);
      if (!item.ok) return { ok: false };
      value[key] = item.value;
    }
    return { ok: true, value };
  }
  return { ok: false };
}

function collectBindings(program) {
  const bindings = new Map();
  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== 'Identifier' || !declaration.init) continue;
      const parsed = safeStaticValue(declaration.init, bindings, { nodes: 0 });
      if (parsed.ok) bindings.set(declaration.id.name, parsed.value);
    }
  }

  // A literal binding is usable only while its value is never reconstructed or
  // handed to executable code that could mutate it. This is deliberately
  // conservative; the common `const patch = "..."` case remains supported.
  const mutated = new Set();
  const rootIdentifier = (node) => {
    let current = node;
    while (current && current.type === 'MemberExpression') current = current.object;
    return current && current.type === 'Identifier' ? current.name : undefined;
  };
  walk.simple(program, {
    AssignmentExpression(node) {
      const name = rootIdentifier(node.left);
      if (name) mutated.add(name);
    },
    UpdateExpression(node) {
      const name = rootIdentifier(node.argument);
      if (name) mutated.add(name);
    },
    CallExpression(node) {
      const isToolCall = toolCalleeName(node) !== undefined;
      if (node.callee.type === 'MemberExpression') {
        const name = rootIdentifier(node.callee);
        if (name && bindings.has(name)) mutated.add(name);
      }
      if (!isToolCall) {
        for (const argument of node.arguments) {
          if (argument.type === 'Identifier' && bindings.has(argument.name)) {
            mutated.add(argument.name);
          }
        }
      }
    },
  });
  for (const name of mutated) bindings.delete(name);
  return { bindings, unexpected: false };
}

function toolCalleeName(node) {
  if (
    !node ||
    node.type !== 'CallExpression' ||
    !node.callee ||
    node.callee.type !== 'MemberExpression' ||
    node.callee.computed ||
    node.callee.optional ||
    node.callee.object.type !== 'Identifier' ||
    node.callee.object.name !== 'tools' ||
    node.callee.property.type !== 'Identifier'
  ) {
    return undefined;
  }
  return node.callee.property.name;
}

function extractExecDescriptors(source) {
  if (typeof source !== 'string' || source === '') {
    return { descriptors: [], unexpected: true, truncated: false };
  }
  if (source.length > CODEX_TOOL_LIMITS.MAX_EXEC_SOURCE) {
    return { descriptors: [], unexpected: true, truncated: true };
  }
  let program;
  try {
    program = acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true,
    });
    let astNodes = 0;
    walk.full(program, () => {
      astNodes += 1;
      if (astNodes > CODEX_TOOL_LIMITS.MAX_AST_NODES) throw new Error('AST limit');
    });
  } catch {
    return { descriptors: [], unexpected: true, truncated: false };
  }

  const { bindings, unexpected: bindingDrift } = collectBindings(program);
  const calls = [];
  walk.simple(program, {
    CallExpression(node) {
      const rawName = toolCalleeName(node);
      if (rawName) calls.push({ node, rawName });
    },
  });
  calls.sort((left, right) => left.node.start - right.node.start);

  let unexpected = bindingDrift || calls.length === 0;
  const truncated = calls.length > CODEX_TOOL_LIMITS.MAX_CALLS_PER_EXEC;
  const descriptors = [];
  for (const { node, rawName } of calls.slice(0, CODEX_TOOL_LIMITS.MAX_CALLS_PER_EXEC)) {
    const values = [];
    let staticArgs = true;
    for (const argument of node.arguments) {
      if (argument.type === 'SpreadElement') {
        staticArgs = false;
        break;
      }
      const parsed = safeStaticValue(argument, bindings, { nodes: 0 });
      if (!parsed.ok) {
        staticArgs = false;
        break;
      }
      values.push(parsed.value);
    }
    const input = staticArgs ? normalizedInput(rawName, values) : {};
    if (!staticArgs) unexpected = true;
    descriptors.push({
      ordinal: descriptors.length,
      rawName,
      displayName: displayNameForTool(rawName, input),
      input,
      eventBacked:
        rawName === 'apply_patch' ||
        rawName.startsWith('mcp__') ||
        /^(?:image_gen|image_generation)(?:__|$)/.test(rawName),
    });
  }
  return { descriptors, unexpected: unexpected || truncated, truncated };
}

function outputParts(output) {
  if (typeof output === 'string') {
    return { parts: [{ type: 'text', text: redactImageData(output) }], unexpected: false };
  }
  if (!Array.isArray(output)) return { parts: [], unexpected: true };
  const parts = [];
  let unexpected = false;
  for (const block of output) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      unexpected = true;
      continue;
    }
    if (
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
    ) {
      parts.push({ type: 'text', text: redactImageData(block.text) });
    } else if (
      block.type === 'image' ||
      block.type === 'input_image' ||
      block.type === 'output_image'
    ) {
      parts.push({ type: 'image', text: '[image]' });
    } else if (typeof block.type === 'string') {
      parts.push({ type: 'unknown', text: `[${block.type}]` });
      unexpected = true;
    } else {
      unexpected = true;
    }
  }
  return { parts, unexpected };
}

function scriptEnvelope(text) {
  const match = /^(Script (completed|failed|running)[^\r\n]*)(?:\r?\n|$)/.exec(text);
  if (!match) return undefined;
  const status = match[2];
  const marker = /(?:^|\r?\n)Output:\r?\n/.exec(text);
  let body = marker ? text.slice(marker.index + marker[0].length) : '';
  if (status === 'running') {
    const id = /cell ID ([^\s]+)/i.exec(match[1]);
    const note = `[script continues${id ? ` as cell ${id[1]}` : ''}]`;
    body = body.replace(/\s+$/, '');
    body = body ? `${body}\n${note}` : note;
  }
  return { text: body, isError: status === 'failed', unexpected: !marker && status === 'completed' };
}

function commandEnvelope(text) {
  const exited = /(?:^|\r?\n)Process exited with code (-?\d+)(?:\r?\n|$)/.exec(text);
  const running = /(?:^|\r?\n)Process running with session ID ([^\s]+)(?:\r?\n|$)/.exec(text);
  if (!exited && !running) return undefined;
  const marker = /(?:^|\r?\n)(?:Final|Live) output:\r?\n/.exec(text);
  let body = marker ? text.slice(marker.index + marker[0].length) : '';
  let isError = false;
  if (exited) {
    const code = Number(exited[1]);
    isError = code !== 0;
    if (isError && body.trim() === '') body = `[process exited with code ${code}]`;
  }
  if (running) {
    const note = `[process continues as session ${running[1]}]`;
    body = body.replace(/\s+$/, '');
    body = body ? `${body}\n${note}` : note;
  }
  return { text: body, isError, unexpected: !marker };
}

function decodeCodexOutput(output, options = {}) {
  const decoded = outputParts(output);
  let { parts } = decoded;
  let unexpected = decoded.unexpected;
  let isError = false;

  if (options.wrapper && parts[0] && parts[0].type === 'text') {
    const envelope = scriptEnvelope(parts[0].text);
    if (envelope) {
      isError = envelope.isError;
      unexpected = unexpected || envelope.unexpected;
      parts = envelope.text
        ? [{ type: 'text', text: envelope.text }, ...parts.slice(1)]
        : parts.slice(1);
    }
  }

  let text = parts.map((part) => part.text).join('\n');
  if (options.command) {
    const envelope = commandEnvelope(text);
    if (envelope) {
      text = envelope.text;
      isError = isError || envelope.isError;
      unexpected = unexpected || envelope.unexpected;
    } else if (text !== '') {
      unexpected = true;
    }
  }
  return { text, isError, unexpected };
}

// Convert ordinary unified diff hunks to the structured patch shape already
// consumed by the provider-neutral counter and numbered-diff renderer.
function unifiedDiffToStructuredPatch(diff) {
  if (typeof diff !== 'string' || diff === '') return undefined;
  const hunks = [];
  let current;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line === '\\ No newline at end of file') continue;
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      current.lines.push(redactImageData(line));
    }
  }
  return hunks.some((hunk) => hunk.lines.length > 0) ? hunks : undefined;
}

module.exports = {
  CODEX_TOOL_LIMITS,
  decodeCodexOutput,
  displayNameForTool,
  extractExecDescriptors,
  firstWebQuery,
  normalizedInput,
  redactImageData,
  unifiedDiffToStructuredPatch,
};
