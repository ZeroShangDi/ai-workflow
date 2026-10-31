import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CharacterSettings } from '../src/settings.mjs';

test('loads both built-in settings with default and optional images', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new CharacterSettings({ selectionFile: path.join(directory, 'selection.json') });
  const value = store.list();
  assert.equal(value.defaultId, 'elf-3');
  assert.equal(value.selectedId, 'elf-3');
  assert.deepEqual(value.characters.map((item) => item.id).sort(), ['elf-3', 'whale-3']);
  assert.equal(value.setting.images.multiView, 'images/elf-sheet-v2.png');
  assert.equal(value.setting.persona.length > 1000, true);
  assert.equal(value.setting.skillInstructions.length > 100, true);
  assert.equal(Object.keys(value.setting.actionGroups).length > 0, true);
  assert.equal(store.setting('whale-3').images.multiView, '');
});

test('selecting a setting persists for later calls', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'character-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'selection.json');
  const first = new CharacterSettings({ selectionFile: file });
  assert.equal(first.select('whale-3').selectedId, 'whale-3');
  const second = new CharacterSettings({ selectionFile: file });
  assert.equal(second.selectedId(), 'whale-3');
  assert.equal(second.selected().name, '鲸鱼娘');
  assert.throws(() => second.select('unknown-3'), /Unknown character setting/);
});
