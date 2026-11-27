import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const data = JSON.parse(await readFile(new URL('../data/records.json', import.meta.url), 'utf8'));

test("历史证照引用科目且夜班跨旧证到期", () => {
  for (const [collection, rows] of Object.entries(data)) {
    const ids = rows.map((row) => row.id);
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), collection);
    assert.equal(new Set(ids).size, ids.length, collection);
  }
  for (const [collection, field, related] of [
  [
    "centres",
    "region",
    "regions"
  ],
  [
    "scores",
    "centre",
    "centres"
  ],
  [
    "certificates",
    "scope",
    "scores"
  ],
  [
    "certificates",
    "region",
    "regions"
  ],
  [
    "exams",
    "centre",
    "centres"
  ],
  [
    "shifts",
    "region",
    "regions"
  ],
  [
    "proofLetters",
    "shift",
    "shifts"
  ],
  [
    "proofLetters",
    "certificate",
    "certificates"
  ],
  [
    "examClaims",
    "exam",
    "exams"
  ],
  [
    "scoreRevisions",
    "score",
    "scores"
  ]
]) {
    const ids = new Set(data[related].map((row) => row.id));
    for (const row of data[collection]) {
      for (const id of [row[field]].flat()) {
        assert.ok(ids.has(id), collection + '/' + row.id + '/' + field);
      }
    }
  }
  for (const [collection, id, field, expected] of [
  [
    "certificates",
    "cert-r1",
    "until",
    "2027-02-01T16:00:00Z"
  ],
  [
    "exams",
    "exam-r1",
    "seats",
    1
  ],
  [
    "scores",
    "score-nt",
    "subject",
    "theory"
  ],
  [
    "shifts",
    "night-r",
    "until",
    "2027-02-01T19:00:00Z"
  ]
]) {
    assert.deepEqual(data[collection].find((row) => row.id === id)?.[field], expected);
  }
});
