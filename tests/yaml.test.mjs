// Tests for yaml.js — the browser-side YAML subset parser/emitter.
// Run with: node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { parseYaml, emitTestCase, YamlUnsupportedError } from "../yaml.js";

const FULL_CASE = {
  id: "TC-0001",
  title: "User can complete checkout with saved card",
  suite: "checkout",
  priority: "high",
  status: "active",
  automated: false,
  owner: "piotr.wicherski",
  tags: ["regression", "payments"],
  linked_ticket: "UMA-19870",
  preconditions: ["User is logged in", "User has a saved payment card"],
  steps: [
    { action: "Add an item to the cart", expected: "Item appears in cart with correct price" },
    { action: "Confirm the order", expected: "Order confirmation screen appears with order number" },
  ],
  created_at: "2026-07-21",
  updated_at: "2026-07-21",
};

// --- emitTestCase ---

test("emits a full test case with fixed field order and minimal quoting", () => {
  const expected = `id: TC-0001
title: User can complete checkout with saved card
suite: checkout
priority: high
status: active
automated: false
owner: piotr.wicherski
tags:
  - regression
  - payments
linked_ticket: UMA-19870
preconditions:
  - User is logged in
  - User has a saved payment card
steps:
  - action: Add an item to the cart
    expected: Item appears in cart with correct price
  - action: Confirm the order
    expected: Order confirmation screen appears with order number
created_at: "2026-07-21"
updated_at: "2026-07-21"
`;
  assert.equal(emitTestCase(FULL_CASE), expected);
});

test("emits minimal test case, omitting empty optional fields", () => {
  const tc = {
    id: "TC-0042",
    title: "Minimal case",
    suite: "misc",
    priority: "low",
    status: "draft",
    automated: true,
    owner: "",
    tags: [],
    linked_ticket: undefined,
    preconditions: [],
    steps: [{ action: "Do a thing", expected: "It works" }],
  };
  const expected = `id: TC-0042
title: Minimal case
suite: misc
priority: low
status: draft
automated: true
steps:
  - action: Do a thing
    expected: It works
`;
  assert.equal(emitTestCase(tc), expected);
});

test("quotes strings that YAML would misinterpret", () => {
  const tc = {
    id: "TC-0002",
    title: "Login: edge case with 'quotes' and #hash",
    suite: "auth",
    priority: "medium",
    status: "active",
    automated: false,
    steps: [{ action: "Enter password: hunter2", expected: "0001" }],
  };
  const out = emitTestCase(tc);
  assert.match(out, /^title: "Login: edge case with 'quotes' and #hash"$/m);
  assert.match(out, /^  - action: "Enter password: hunter2"$/m);
  assert.match(out, /^    expected: "0001"$/m);
});

test("quotes reserved words and multiline strings", () => {
  const tc = {
    id: "TC-0003",
    title: "yes",
    suite: "misc",
    priority: "low",
    status: "draft",
    automated: false,
    steps: [{ action: "Run", expected: "line one\nline two" }],
  };
  const out = emitTestCase(tc);
  assert.match(out, /^title: "yes"$/m);
  assert.match(out, /^    expected: "line one\\nline two"$/m);
});

// --- parseYaml ---

test("parses scalars with type coercion matching PyYAML", () => {
  const doc = parseYaml(`id: TC-0001
count: 3
ratio: 0.5
automated: false
enabled: yes
missing: null
name: plain string value
`);
  assert.deepEqual(doc, {
    id: "TC-0001",
    count: 3,
    ratio: 0.5,
    automated: false,
    enabled: true,
    missing: null,
    name: "plain string value",
  });
});

test("parses quoted strings with escapes", () => {
  const doc = parseYaml(`a: "line one\\nline two"
b: "has: colon"
c: 'single ''quoted'' value'
d: "0001"
`);
  assert.deepEqual(doc, {
    a: "line one\nline two",
    b: "has: colon",
    c: "single 'quoted' value",
    d: "0001",
  });
});

test("ignores comments and blank lines, allows leading document marker", () => {
  const doc = parseYaml(`---
# a comment
id: TC-0009

title: Something  # trailing comment
`);
  assert.deepEqual(doc, { id: "TC-0009", title: "Something" });
});

test("parses block sequences of scalars", () => {
  const doc = parseYaml(`tags:
  - regression
  - payments
`);
  assert.deepEqual(doc, { tags: ["regression", "payments"] });
});

test("parses block sequences of mappings", () => {
  const doc = parseYaml(`steps:
  - action: Step one
    expected: Result one
  - action: Step two
    expected: Result two
`);
  assert.deepEqual(doc, {
    steps: [
      { action: "Step one", expected: "Result one" },
      { action: "Step two", expected: "Result two" },
    ],
  });
});

test("round-trips a full test case", () => {
  assert.deepEqual(parseYaml(emitTestCase(FULL_CASE)), FULL_CASE);
});

test("round-trips tricky strings", () => {
  const tc = {
    id: "TC-0100",
    title: "Zażółć: gęślą jaźń — dashes & \"double quotes\"",
    suite: "intl",
    priority: "critical",
    status: "active",
    automated: false,
    tags: ["true", "0755"],
    preconditions: ["Value ends with colon:", "  leading spaces kept"],
    steps: [{ action: "Multi\nline\naction", expected: "# not a comment" }],
    created_at: "2026-07-23",
    updated_at: "2026-07-23",
  };
  assert.deepEqual(parseYaml(emitTestCase(tc)), tc);
});

test("throws YamlUnsupportedError on block scalars", () => {
  assert.throws(() => parseYaml("description: |\n  block text\n"), YamlUnsupportedError);
});

test("throws YamlUnsupportedError on anchors and flow collections", () => {
  assert.throws(() => parseYaml("a: &anchor value\n"), YamlUnsupportedError);
  assert.throws(() => parseYaml("a: {b: 1}\n"), YamlUnsupportedError);
  assert.throws(() => parseYaml("a: [1, 2]\n"), YamlUnsupportedError);
});

test("throws YamlUnsupportedError on ambiguous unquoted colon", () => {
  assert.throws(() => parseYaml("title: Login: edge case\n"), YamlUnsupportedError);
});

test("throws YamlUnsupportedError on tab indentation", () => {
  assert.throws(() => parseYaml("steps:\n\t- action: x\n"), YamlUnsupportedError);
});
