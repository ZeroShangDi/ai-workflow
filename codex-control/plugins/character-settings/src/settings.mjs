import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}-[1-9][0-9]{0,8}$/;

function directoryFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
}

function readDocument(directory, name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name)) return '';
  const file = path.resolve(directory, name);
  if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8').slice(0, 40000);
}

function loadSetting(directory) {
  const file = path.join(directory, 'setting.json');
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.schemaVersion !== 1 || !ID_PATTERN.test(value.id) || path.basename(directory) !== value.id) {
    throw new Error(`Invalid character setting: ${directory}`);
  }
  if (typeof value.name !== 'string' || !value.name.trim()) throw new Error(`Character name is required: ${value.id}`);
  const documents = value.documents || {};
  const persona = readDocument(directory, documents.persona);
  const skills = readDocument(directory, documents.skills);
  if (!persona || !skills) throw new Error(`Character documents are incomplete: ${value.id}`);
  const referenceText = readDocument(directory, value.voice?.referenceTextFile);
  if (!referenceText) throw new Error(`Character voice reference text is missing: ${value.id}`);
  return {
    ...value,
    persona,
    skillInstructions: skills,
    voice: {
      ...value.voice,
      referenceText,
    },
  };
}

export class CharacterSettings {
  constructor({
    root = path.resolve(import.meta.dirname, '..'),
    defaultId = process.env.CHARACTER_DEFAULT_ID || 'elf-3',
    selectionFile = null,
  } = {}) {
    this.root = path.resolve(root);
    this.charactersRoot = path.join(this.root, 'characters');
    this.defaultId = defaultId;
    this.selectionFile = selectionFile ? path.resolve(selectionFile) : path.join(this.root, 'data', 'selection.json');
    this.settings = new Map();
    for (const directory of directoryFiles(this.charactersRoot)) {
      const setting = loadSetting(directory);
      if (setting) this.settings.set(setting.id, setting);
    }
    if (!this.settings.size) throw new Error('No character settings were found');
    if (!this.settings.has(this.defaultId)) {
      this.defaultId = [...this.settings.keys()][0];
    }
  }

  selectedId() {
    try {
      const value = JSON.parse(fs.readFileSync(this.selectionFile, 'utf8'));
      if (typeof value.id === 'string' && this.settings.has(value.id)) return value.id;
    } catch {
      // A missing or invalid local selection falls back to the built-in default.
    }
    return this.defaultId;
  }

  selected() {
    return this.setting(this.selectedId());
  }

  setting(id) {
    const setting = this.settings.get(String(id || ''));
    return setting ? structuredClone(setting) : null;
  }

  list(id = null) {
    const selectedId = this.selectedId();
    const requested = id ? this.setting(id) : this.selected();
    return {
      defaultId: this.defaultId,
      selectedId,
      characters: [...this.settings.values()].map((setting) => ({
        id: setting.id,
        name: setting.name,
        card: setting.card,
        voiceProfile: setting.voice?.profile || null,
        hasMultiViewImage: Boolean(setting.images?.multiView),
        actionGroupNames: Object.keys(setting.actionGroups || {}),
      })),
      setting: requested,
    };
  }

  select(id) {
    const value = this.setting(id);
    if (!value) throw new Error(`Unknown character setting: ${id}`);
    fs.mkdirSync(path.dirname(this.selectionFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.selectionFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ id: value.id }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.selectionFile);
    return { selectedId: value.id, setting: value };
  }
}
