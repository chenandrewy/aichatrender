'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  recentSessionDateParts,
  sessionMetaFromLine,
  cachedSessionMeta,
  createCodexParser,
  parseLine,
} = require('../codex');
const { LIMITS, applyToolResults } = require('../transcript');

const OPTS = { includeUser: true, sessionTimestamp: '2026-07-23T17:00:00.000Z' };

function line(type, payload, timestamp) {
  const rec = { type, payload };
  if (timestamp !== undefined) rec.timestamp = timestamp;
  return JSON.stringify(rec);
}

function parseSession(records, opts = OPTS) {
  const parser = createCodexParser();
  const messages = [];
  let unexpected = false;
  for (const record of records) {
    const parsed = parser.parseLine(
      typeof record === 'string' ? record : JSON.stringify(record),
      opts,
    );
    messages.push(...parsed.messages);
    applyToolResults(messages, parsed.results);
    unexpected ||= parsed.unexpected;
  }
  return { messages, unexpected };
}

test('discovery dates: local calendar window is stable at UTC and DST boundaries', () => {
  // 21:30 the previous day in New York: the window must follow the local date,
  // not the UTC one, because that is how Codex names the directories.
  assert.deepEqual(
    recentSessionDateParts(Date.parse('2026-07-24T01:30:00.000Z'), 3, 'America/New_York'),
    [
      ['2026', '07', '24'],
      ['2026', '07', '23'],
      ['2026', '07', '22'],
      ['2026', '07', '21'],
    ],
  );
  // Spring-forward: 2026-03-08 is a 23-hour day in New York, so fixed 24-hour
  // subtraction would skip a date.
  assert.deepEqual(
    recentSessionDateParts(Date.parse('2026-03-09T00:30:00.000Z'), 3, 'America/New_York'),
    [
      ['2026', '03', '09'],
      ['2026', '03', '08'],
      ['2026', '03', '07'],
      ['2026', '03', '06'],
    ],
  );
});

test('discovery dates: the window is anchored to the given zone, not to New York', () => {
  // Same instant, two zones on opposite sides of the date line: Tokyo is
  // already on the 24th while New York is still on the 23rd. Hardcoding New
  // York would make a Tokyo user's live session directory invisible.
  const at = Date.parse('2026-07-24T01:30:00.000Z');
  assert.deepEqual(recentSessionDateParts(at, 1, 'Asia/Tokyo'), [
    ['2026', '07', '25'],
    ['2026', '07', '24'],
  ]);
  assert.deepEqual(recentSessionDateParts(at, 1, 'America/New_York'), [
    ['2026', '07', '24'],
    ['2026', '07', '23'],
  ]);
  // Omitting the zone uses the host's, whatever the test machine is set to.
  assert.equal(recentSessionDateParts(at, 1).length, 2);
});

test('metadata cache: negative result is reused until the file size changes', () => {
  const cache = new Map();
  let reads = 0;
  let firstLine;
  const read = () => {
    reads += 1;
    return firstLine;
  };

  assert.equal(cachedSessionMeta(cache, '/logical/rollout.jsonl', 7, 10, read), undefined);
  assert.equal(cachedSessionMeta(cache, '/logical/rollout.jsonl', 7, 10, read), undefined);
  assert.equal(reads, 1);

  firstLine = line('session_meta', {
    cwd: '/workspace/project',
    timestamp: '2026-07-23T18:00:00.000Z',
  });
  assert.deepEqual(cachedSessionMeta(cache, '/logical/rollout.jsonl', 7, 11, read), {
    cwd: '/workspace/project',
    timestamp: '2026-07-23T18:00:00.000Z',
  });
  assert.equal(reads, 2);

  // A positive result is immutable for this path+inode and survives later growth.
  assert.deepEqual(cachedSessionMeta(cache, '/logical/rollout.jsonl', 7, 99, read), {
    cwd: '/workspace/project',
    timestamp: '2026-07-23T18:00:00.000Z',
  });
  assert.equal(reads, 2);
});

test('metadata cache: malformed first line is negatively cached by size', () => {
  const cache = new Map();
  let reads = 0;
  const read = () => {
    reads += 1;
    return line('future_meta_type', { cwd: '/workspace/project' });
  };
  assert.equal(cachedSessionMeta(cache, '/logical/bad.jsonl', 8, 20, read), undefined);
  assert.equal(cachedSessionMeta(cache, '/logical/bad.jsonl', 8, 20, read), undefined);
  assert.equal(reads, 1);
});

test('metadata cache: a growing unparseable file holds one entry, not one per size', () => {
  const cache = new Map();
  let reads = 0;
  const read = () => {
    reads += 1;
    return line('future_meta_type', { cwd: '/workspace/project' });
  };
  // A file appended to on every discovery tick that never yields session_meta.
  for (let size = 1; size <= 50; size += 1) {
    assert.equal(cachedSessionMeta(cache, '/logical/growing.jsonl', 9, size, read), undefined);
  }
  assert.equal(reads, 50); // each new size is retried exactly once
  assert.equal(cache.size, 1); // and the entry is replaced, never accumulated
});

test('session metadata: extracts immutable cwd and timestamp from first line', () => {
  const meta = sessionMetaFromLine(
    line(
      'session_meta',
      {
        cwd: '/workspace/real-project',
        timestamp: '2026-07-23T18:00:00.000Z',
        forked_from_id: 'synthetic-parent',
      },
      '2026-07-23T18:00:01.000Z',
    ),
  );
  assert.deepEqual(meta, {
    cwd: '/workspace/real-project',
    timestamp: '2026-07-23T18:00:00.000Z',
  });
});

test('session metadata: malformed or changed first lines fail soft', () => {
  assert.equal(sessionMetaFromLine('{'), undefined);
  assert.equal(sessionMetaFromLine('[]'), undefined);
  assert.equal(sessionMetaFromLine(line('event_msg', { cwd: '/workspace' })), undefined);
  assert.equal(sessionMetaFromLine(line('session_meta', { cwd: 42 })), undefined);
});

test('assistant: canonical response item renders output_text via shared segmenter', () => {
  const r = parseLine(
    line(
      'response_item',
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'By \\(a=b\\), so $$c=d$$.' }],
      },
      '2026-07-23T18:00:04.000Z',
    ),
    OPTS,
  );
  assert.equal(r.unexpected, false);
  assert.deepEqual(r.messages, [
    {
      ts: '2026-07-23T18:00:04.000Z',
      role: 'assistant',
      spans: [
        { t: 'text', s: 'By ' },
        { t: 'math', m: 'inline', s: 'a=b' },
        { t: 'text', s: ', so ' },
        { t: 'math', m: 'display', s: 'c=d' },
        { t: 'text', s: '.' },
      ],
    },
  ]);
});

test('dedup: event agent copy and response user context are skipped', () => {
  const assistantCopy = line('event_msg', {
    type: 'agent_message',
    message: 'Duplicated assistant text.',
    phase: 'final_answer',
  });
  const injectedUser = line('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Injected instructions.' }],
  });
  assert.deepEqual(parseLine(assistantCopy, OPTS), { messages: [], unexpected: false });
  assert.deepEqual(parseLine(injectedUser, OPTS), { messages: [], unexpected: false });
});

test('user: event user_message is kept only when enabled', () => {
  const user = line(
    'event_msg',
    { type: 'user_message', message: 'What is $x^2$?', images: [] },
    '2026-07-23T18:00:03.000Z',
  );
  assert.equal(parseLine(user, { includeUser: false }).messages.length, 0);
  assert.deepEqual(parseLine(user, OPTS).messages[0], {
    ts: '2026-07-23T18:00:03.000Z',
    role: 'user',
    spans: [
      { t: 'text', s: 'What is ' },
      { t: 'math', m: 'inline', s: 'x^2' },
      { t: 'text', s: '?' },
    ],
  });
});

test('timestamps: missing per-record timestamp falls back to session metadata', () => {
  const r = parseLine(
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Synthetic answer.' }],
    }),
    OPTS,
  );
  assert.equal(r.messages[0].ts, OPTS.sessionTimestamp);
});

test('fail-soft: malformed JSON and unexpected consumable shapes', () => {
  assert.deepEqual(parseLine('{', OPTS), { messages: [], unexpected: false });
  assert.equal(parseLine('123', OPTS).unexpected, true);
  assert.equal(
    parseLine(
      line('response_item', { type: 'message', role: 'assistant', content: 'changed' }),
      OPTS,
    ).unexpected,
    true,
  );
  assert.equal(
    parseLine(line('event_msg', { type: 'user_message', message: ['changed'] }), OPTS)
      .unexpected,
    true,
  );
});

test('bookkeeping: reasoning and unrelated unknown records are ignored', () => {
  for (const sample of [
    line('response_item', { type: 'reasoning', summary: [] }),
    line('event_msg', { type: 'token_count' }),
    line('turn_context', { cwd: '/workspace' }),
    line('world_state', {}),
    line('new_future_type', {}),
  ]) {
    assert.deepEqual(parseLine(sample, OPTS), { messages: [], unexpected: false });
  }
  assert.equal(
    parseLine(line('response_item', { type: 'custom_tool_call_output', output: 'test' }), OPTS)
      .unexpected,
    true,
  );
});

test('fixture: synthetic rollout keeps prose deduplicated and renders its generic tool', () => {
  const lines = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'rollout.jsonl'), 'utf8')
    .trimEnd()
    .split('\n');
  assert.deepEqual(sessionMetaFromLine(lines[0]), {
    cwd: '/workspace/example',
    timestamp: '2026-07-23T18:00:00.000Z',
  });
  const { messages } = parseSession(lines);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
  assert.deepEqual(messages[1].spans, [
    { t: 'text', s: 'Commutativity gives ' },
    { t: 'math', m: 'display', s: 'x+y=y+x' },
    { t: 'text', s: '.' },
  ]);
  assert.deepEqual(messages[2].tool, {
    id: 'call_1',
    name: 'synthetic',
    summary: '{}',
  });
  assert.deepEqual(messages[2].result, {
    text: 'Synthetic output.',
    more: 0,
    isError: false,
  });
});

test('direct command: pending call joins a stripped successful result', () => {
  const parser = createCodexParser();
  const call = parser.parseLine(
    line('response_item', {
      type: 'function_call',
      name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'npm test', workdir: '/workspace/project' }),
      call_id: 'call_direct',
    }),
    { ...OPTS, cwd: '/workspace/project' },
  );
  assert.equal(call.unexpected, false);
  assert.deepEqual(call.messages[0].tool, {
    id: 'call_direct',
    name: 'Bash',
    summary: 'npm test',
  });
  assert.equal(call.messages[0].result, undefined);

  const output = parser.parseLine(
    line('response_item', {
      type: 'function_call_output',
      call_id: 'call_direct',
      output: [
        {
          type: 'input_text',
          text: 'Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nFinal output:\npassed',
        },
      ],
    }),
    OPTS,
  );
  assert.deepEqual(output.results, [
    { id: 'call_direct', text: 'passed', more: 0, isError: false },
  ]);
  assert.equal(output.unexpected, false);
});

test('direct command: failures and running sessions retain their status', () => {
  const failed = parseSession([
    line('response_item', {
      type: 'function_call', name: 'exec_command', arguments: '{"cmd":"false"}', call_id: 'bad',
    }),
    line('response_item', {
      type: 'function_call_output', call_id: 'bad',
      output: 'Process exited with code 7\nFinal output:\npermission denied',
    }),
  ]).messages[0];
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.text, 'permission denied');

  const running = parseSession([
    line('response_item', {
      type: 'function_call', name: 'exec_command', arguments: '{"cmd":"watch"}', call_id: 'run',
    }),
    line('response_item', {
      type: 'function_call_output', call_id: 'run',
      output: 'Process running with session ID 42\nLive output:\nstarted',
    }),
  ]).messages[0];
  assert.equal(running.result.isError, false);
  assert.equal(running.result.text, 'started\n[process continues as session 42]');
});

test('direct results use the shared clipping limits and duplicate output is inert', () => {
  const parser = createCodexParser();
  const messages = [];
  const call = parser.parseLine(line('response_item', {
    type: 'function_call', name: 'update_plan', arguments: '{"plan":[]}', call_id: 'clip',
  }), OPTS);
  messages.push(...call.messages);
  const output = parser.parseLine(line('response_item', {
    type: 'function_call_output', call_id: 'clip',
    output: Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'),
  }), OPTS);
  applyToolResults(messages, output.results);
  assert.equal(messages[0].result.text.split('\n').length, 8);
  assert.equal(messages[0].result.more, 4);
  assert.deepEqual(
    parser.parseLine(line('response_item', {
      type: 'function_call_output', call_id: 'clip', output: 'replacement',
    }), OPTS),
    { messages: [], unexpected: false },
  );
  assert.match(messages[0].result.text, /^line 1/);
});

test('direct command: long JSONL stdout is visibly shortened per line', () => {
  const jsonl = Array.from({ length: 5 }, (_, index) =>
    `${index + 1}:${JSON.stringify({ message: 'x'.repeat(700) })}`,
  ).join('\n');
  const parsed = parseSession([
    line('response_item', {
      type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg -n pattern log.jsonl"}',
      call_id: 'long-jsonl',
    }),
    line('response_item', {
      type: 'function_call_output', call_id: 'long-jsonl',
      output: `Process exited with code 0\nFinal output:\n${jsonl}`,
    }),
  ]);

  const result = parsed.messages[0].result;
  const shown = result.text.split('\n');
  assert.equal(parsed.unexpected, false);
  assert.equal(parsed.messages[0].tool.name, 'Bash');
  assert.equal(shown.length, 5);
  assert.equal(shown.every((item) => item.length <= LIMITS.TOOL_RESULT_COLS + 1), true);
  assert.equal(shown.every((item) => item.endsWith('…')), true);
  assert.equal(result.more, 0);
});

test('direct calls: aliases, relative paths, unknown names, and malformed arguments fail soft', () => {
  const parser = createCodexParser();
  const cases = [
    ['write_stdin', { session_id: 12 }, 'BashOutput', '12'],
    ['wait', { cell_id: 'cell-7' }, 'Wait', 'cell-7'],
    ['view_image', { path: '/workspace/project/dev/shot.png' }, 'ViewImage', 'dev/shot.png'],
    ['update_plan', { plan: [] }, 'UpdatePlan', ''],
    ['future__tool', { label: 'safe value' }, 'future__tool', 'safe value'],
  ];
  cases.forEach(([rawName, input, name, summary], index) => {
    const parsed = parser.parseLine(
      line('response_item', {
        type: 'function_call', raw: true, name: rawName,
        arguments: JSON.stringify(input), call_id: `alias-${index}`,
      }),
      { ...OPTS, cwd: '/workspace/project' },
    );
    assert.deepEqual(parsed.messages[0].tool, { id: `alias-${index}`, name, summary });
  });
  const malformed = parser.parseLine(
    line('response_item', {
      type: 'function_call', name: 'future_tool', arguments: '{', call_id: 'malformed',
    }),
    OPTS,
  );
  assert.equal(malformed.messages[0].tool.name, 'future_tool');
  assert.equal(malformed.unexpected, true);
});

test('content arrays reduce images to a marker and ViewImage collapses it', () => {
  const parsed = parseSession([
    line('response_item', {
      type: 'function_call', name: 'view_image',
      arguments: '{"path":"/tmp/shot.png"}', call_id: 'image-view',
    }),
    line('response_item', {
      type: 'function_call_output', call_id: 'image-view',
      output: [{ type: 'input_image', image_url: 'data:image/png;base64,PRIVATE' }],
    }),
  ]);
  assert.deepEqual(parsed.messages[0].result, {
    text: '', more: 0, isError: false, summary: 'image',
  });
  assert.doesNotMatch(JSON.stringify(parsed.messages), /PRIVATE|data:image/);
});

test('code-mode: one static inner call renders instead of the outer JavaScript', () => {
  const parsed = parseSession([
    line('response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'outer',
      input: "const r = await tools.exec_command({cmd: `pwd`, workdir: '/workspace/project'}); text(r.output);",
    }),
    line('response_item', {
      type: 'custom_tool_call_output', call_id: 'outer',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 0.1 seconds\nOutput:\n' },
        { type: 'input_text', text: '/workspace/project' },
      ],
    }),
  ], { ...OPTS, cwd: '/workspace/project' });
  assert.equal(parsed.unexpected, false);
  assert.deepEqual(parsed.messages[0].tool, { id: 'outer', name: 'Bash', summary: 'pwd' });
  assert.equal(parsed.messages[0].result.text, '/workspace/project');
});

test('code-mode: multi-tool wrappers use an explicit aggregate and drift notice', () => {
  const parsed = parseSession([
    line('response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'batch',
      input: 'const a = tools.exec_command({cmd: "one"}); const b = tools.wait({cell_id: "two"}); text(a); text(b);',
    }),
    line('response_item', {
      type: 'custom_tool_call_output', call_id: 'batch', output: 'Script completed\nOutput:\none\ntwo',
    }),
  ]);
  assert.equal(parsed.unexpected, true);
  assert.deepEqual(parsed.messages[0].tool, {
    id: 'batch', name: 'Exec', summary: 'batch: 2 tools',
  });
  assert.equal(parsed.messages[0].result.text, 'one\ntwo');
});

test('parser reset drops pending state and duplicate or unmatched outputs stay ignored', () => {
  const parser = createCodexParser();
  parser.parseLine(line('response_item', {
    type: 'function_call', name: 'update_plan', arguments: '{"plan":[]}', call_id: 'old',
  }), OPTS);
  parser.reset();
  assert.deepEqual(
    parser.parseLine(line('response_item', {
      type: 'function_call_output', call_id: 'old', output: 'late',
    }), OPTS),
    { messages: [], unexpected: false },
  );
});

test('patch events render one cwd-relative card per add, edit, delete, and move', () => {
  const parsed = parseSession([
    line('event_msg', {
      type: 'patch_apply_end', call_id: 'patch-1', success: true, status: 'completed',
      changes: {
        '/workspace/project/new.txt': {
          type: 'add', content: 'one\ntwo\n',
          unified_diff: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+one\n+two',
        },
        '/workspace/project/edit.txt': {
          type: 'update',
          unified_diff: '--- a/edit.txt\n+++ b/edit.txt\n@@ -4,2 +4,2 @@\n-old\n+new\n same',
        },
        '/workspace/project/delete.txt': {
          type: 'delete',
          unified_diff: '--- a/delete.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two',
        },
        '/workspace/project/old.txt': {
          type: 'update', move_path: '/workspace/project/moved.txt',
          unified_diff: '--- a/old.txt\n+++ b/moved.txt\n@@ -1 +1 @@\n-old\n+new',
        },
      },
    }),
  ], { ...OPTS, cwd: '/workspace/project' });
  assert.equal(parsed.unexpected, false);
  assert.deepEqual(parsed.messages.map((message) => message.tool.name), [
    'Write', 'Edit', 'Delete', 'Edit',
  ]);
  assert.deepEqual(parsed.messages.map((message) => message.tool.summary), [
    'new.txt', 'edit.txt', 'delete.txt', 'old.txt → moved.txt',
  ]);
  assert.equal(parsed.messages[0].result.summary, 'Wrote 2 lines');
  assert.equal(parsed.messages[1].result.summary, 'Added 1 line, removed 1 line');
  assert.equal(parsed.messages[1].result.diff.lines[0].n, 4);
  assert.equal(parsed.messages[2].result.summary, 'Removed 2 lines');
  assert.equal(
    parsed.messages[3].result.summary,
    'Added 1 line, removed 1 line; Moved to moved.txt',
  );
});

test('failed and malformed patch events show a reason and format drift', () => {
  const failed = parseSession([
    line('event_msg', {
      type: 'patch_apply_end', call_id: 'patch-bad', success: false,
      stderr: 'context did not match', changes: {},
    }),
  ]);
  assert.equal(failed.messages[0].result.isError, true);
  assert.equal(failed.messages[0].result.text, 'context did not match');

  const malformed = parseSession([
    line('event_msg', {
      type: 'patch_apply_end', call_id: 'patch-drift', success: true,
      stdout: 'Applied with an unfamiliar diff.',
      changes: {
        '/workspace/project/file.txt': { type: 'update', unified_diff: 'future diff' },
      },
    }),
  ], { ...OPTS, cwd: '/workspace/project' });
  assert.equal(malformed.unexpected, true);
  assert.equal(malformed.messages[0].result.text, 'Applied with an unfamiliar diff.');
});

test('event-backed wrapper patch suppresses the generic outer card', () => {
  const parsed = parseSession([
    line('response_item', {
      type: 'custom_tool_call', name: 'exec', call_id: 'outer-patch',
      input: 'const patch = "*** Begin Patch\\n*** End Patch"; const r = await tools.apply_patch(patch); text(r);',
    }),
    line('event_msg', {
      type: 'patch_apply_end', call_id: 'exec-internal', success: true,
      changes: {
        '/workspace/project/a.txt': {
          type: 'update', unified_diff: '@@ -1 +1 @@\n-old\n+new',
        },
      },
    }),
    line('response_item', {
      type: 'custom_tool_call_output', call_id: 'outer-patch',
      output: 'Script completed\nOutput:\nDone!',
    }),
  ], { ...OPTS, cwd: '/workspace/project' });
  assert.deepEqual(parsed.messages.map((message) => message.tool.name), ['Edit']);
  assert.equal(parsed.messages[0].tool.id, 'exec-internal:0');
});

test('web, MCP, and image-generation completion events stay visible and safe', () => {
  const parsed = parseSession([
    line('event_msg', {
      type: 'web_search_end', call_id: 'web-1', query: 'safe query',
      results: [{ title: 'one' }, { title: 'two' }], status: 'completed',
    }),
    line('response_item', { type: 'web_search_call', call_id: 'web-1', query: 'safe query' }),
    line('event_msg', {
      type: 'mcp_tool_call_end', call_id: 'mcp-1', status: 'completed',
      invocation: { server: 'papers', tool: 'lookup', arguments: { doi: '10/example' } },
      result: { content: [{ type: 'text', text: 'found' }] },
    }),
    line('event_msg', {
      type: 'image_generation_end', call_id: 'img-1', status: 'completed',
      saved_path: '/workspace/project/dev/figure.png',
      result: { image_url: 'data:image/png;base64,SECRET' },
    }),
  ], { ...OPTS, cwd: '/workspace/project' });
  assert.equal(parsed.unexpected, false);
  assert.deepEqual(parsed.messages.map((message) => message.tool.name), [
    'WebSearch', 'papers.lookup', 'ImageGeneration',
  ]);
  assert.equal(parsed.messages[0].result.summary, '2 results');
  assert.equal(parsed.messages[1].result.text, 'found');
  assert.equal(parsed.messages[2].result.summary, 'Saved dev/figure.png');
  assert.doesNotMatch(JSON.stringify(parsed.messages), /SECRET|data:image/);
});

test('MCP failures preserve structured error text', () => {
  const parsed = parseSession([
    line('event_msg', {
      type: 'mcp_tool_call_end', call_id: 'mcp-bad', status: 'failed',
      invocation: { server: 'db', tool: 'query', arguments: { sql: 'select' } },
      result: { isError: true, message: 'access denied' },
    }),
  ]);
  assert.equal(parsed.messages[0].result.isError, true);
  assert.equal(parsed.messages[0].result.text, 'access denied');
});

test('pending state is bounded and eviction raises drift without breaking later calls', () => {
  const parser = createCodexParser();
  let final;
  for (let index = 0; index <= 512; index += 1) {
    final = parser.parseLine(line('response_item', {
      type: 'function_call', name: 'update_plan', arguments: '{"plan":[]}',
      call_id: `pending-${index}`,
    }), OPTS);
  }
  assert.equal(final.unexpected, true);
  assert.deepEqual(
    parser.parseLine(line('response_item', {
      type: 'function_call_output', call_id: 'pending-0', output: 'late',
    }), OPTS),
    { messages: [], unexpected: false },
  );
  assert.equal(
    parser.parseLine(line('response_item', {
      type: 'function_call_output', call_id: 'pending-512', output: 'done',
    }), OPTS).results[0].text,
    'done',
  );
});

test('sanitized tool fixtures cover direct, wrapper, batch, patch, events, and drift', () => {
  const expected = {
    'codex-direct.jsonl': ['Bash'],
    'codex-wrapper.jsonl': ['Bash'],
    'codex-batch.jsonl': ['Exec'],
    'codex-patch.jsonl': ['Edit'],
    'codex-events.jsonl': ['WebSearch', 'fixture.lookup'],
    'codex-malformed.jsonl': ['Exec'],
  };
  for (const [name, tools] of Object.entries(expected)) {
    const lines = fs
      .readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
      .trimEnd()
      .split('\n');
    const parsed = parseSession(lines, { ...OPTS, cwd: '/workspace/synthetic' });
    assert.deepEqual(
      parsed.messages.filter((message) => message.role === 'tool').map((message) => message.tool.name),
      tools,
      name,
    );
    if (name.includes('batch') || name.includes('malformed')) assert.equal(parsed.unexpected, true);
  }
});
