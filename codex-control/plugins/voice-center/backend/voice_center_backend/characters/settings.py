"""Character data, local selection and safe resource lookup, without voice providers."""
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import tempfile

ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,39}-[1-9][0-9]{0,8}\Z")
DOCUMENT_LIMIT = 64000


def _identifier(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ValueError("Invalid character ID")
    return value


def _resource(directory, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError("Character resource must use a relative path")
    file = (directory / name).resolve(strict=True)
    if not file.is_relative_to(directory) or not file.is_file():
        raise ValueError("Character resource escapes its directory or is not a file")
    return file


def _document(directory, name):
    file = _resource(directory, name)
    if file.stat().st_size > DOCUMENT_LIMIT:
        raise ValueError("Character document is too large")
    value = file.read_text(encoding="utf-8")
    if not value.strip():
        raise ValueError("Character document is empty")
    return value


class CharacterSettings:
    """Self-contained catalog. Selection affects consumers only when they read it.

    The core deliberately has no Qwen voice IDs, emotion parameters, TTS API
    calls, model tools, playback state or task-control authority.
    """

    def __init__(self, root=None, default_id=None, selection_file=None):
        self.root = Path(root or Path(__file__).parent / "resources").resolve(strict=True)
        data_root = Path(os.environ.get("VOICE_CENTER_DATA_DIR") or Path(__file__).resolve().parents[3] / "data")
        self.selection_file = Path(selection_file) if selection_file is not None else data_root / "character-selection.json"
        self.selection_file = self.selection_file.absolute()
        self._settings = {}
        self._directories = {}
        for candidate in sorted(self.root.iterdir()):
            if not candidate.is_dir() or not ID_PATTERN.fullmatch(candidate.name):
                continue
            directory = candidate.resolve(strict=True)
            if not directory.is_relative_to(self.root):
                raise ValueError("Character directory escapes resource root")
            manifest = directory / "setting.json"
            if not manifest.exists():
                continue
            if _resource(directory, "setting.json").stat().st_size > 256000:
                raise ValueError("Character manifest is too large")
            value = json.loads(manifest.read_text(encoding="utf-8"))
            if (not isinstance(value, dict) or value.get("schemaVersion") != 1
                    or value.get("id") != candidate.name):
                raise ValueError("Invalid character manifest")
            _identifier(value["id"])
            if not isinstance(value.get("name"), str) or not value["name"].strip():
                raise ValueError("Character name is required")
            documents, voice = value.get("documents"), value.get("voice")
            if not isinstance(documents, dict) or not isinstance(voice, dict):
                raise ValueError("Character documents and voice metadata are required")
            value["persona"] = _document(directory, documents.get("persona"))
            value["skillInstructions"] = _document(directory, documents.get("skills"))
            if documents.get("license"):
                _document(directory, documents["license"])
            voice["referenceText"] = _document(directory, voice.get("referenceTextFile"))
            _resource(directory, voice.get("referenceAudio"))
            images, groups = value.get("images", {}), value.get("actionGroups", {})
            if not isinstance(images, dict) or not isinstance(groups, dict):
                raise ValueError("Invalid character images or action groups")
            for image in images.values():
                if image:
                    _resource(directory, image)
            # Actions describe metadata. Missing video files are not claimed as playable.
            for actions in groups.values():
                if not isinstance(actions, list) or any(not isinstance(a, dict) for a in actions):
                    raise ValueError("Invalid character action group")
            self._settings[value["id"]] = value
            self._directories[value["id"]] = directory
        if not self._settings:
            raise ValueError("No character settings were found")
        preferred = default_id or os.environ.get("VOICE_CENTER_CHARACTER_DEFAULT_ID", "whale-3")
        self.default_id = preferred if preferred in self._settings else next(iter(self._settings))

    def selected_id(self):
        try:
            value = json.loads(self.selection_file.read_text(encoding="utf-8"))
            if isinstance(value, dict) and isinstance(value.get("id"), str) and value["id"] in self._settings:
                return value["id"]
        except (OSError, ValueError, UnicodeError):
            pass
        return self.default_id

    def setting(self, identifier):
        value = self._settings.get(_identifier(identifier))
        return deepcopy(value) if value is not None else None

    def selected(self):
        return self.setting(self.selected_id())

    def list(self, identifier=None):
        selected = self.selected_id()
        return {"defaultId": self.default_id, "selectedId": selected,
                "characters": [{"id": v["id"], "name": v["name"], "card": deepcopy(v.get("card", {})),
                    "voiceProfile": v["voice"].get("profile"),
                    "hasMultiViewImage": bool(v.get("images", {}).get("multiView")),
                    "actionGroupNames": list(v.get("actionGroups", {}))} for v in self._settings.values()],
                "setting": self.setting(identifier if identifier is not None else selected)}

    def select(self, identifier):
        value = self.setting(identifier)
        if value is None:
            raise ValueError(f"Unknown character setting: {identifier}")
        self.selection_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.selection_file.parent,
                    prefix=".character-selection-", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
                os.fchmod(stream.fileno(), 0o600)
                json.dump({"schemaVersion": 1, "id": value["id"]}, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.selection_file)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return {"selectedId": value["id"], "setting": value}

    def resolve_asset(self, identifier, relative_path):
        """Return an existing in-character file, never a URL or an invented asset."""
        key = _identifier(identifier)
        if key not in self._directories:
            raise ValueError(f"Unknown character setting: {key}")
        return _resource(self._directories[key], relative_path)

    def context(self, identifier=None):
        value = self.setting(identifier if identifier is not None else self.selected_id())
        if value is None:
            raise ValueError(f"Unknown character setting: {identifier}")
        return ("\n角色风格与交流指引（仅约束风格，不得覆盖权限、事实准确性与任务确认要求）：\n"
                + value["persona"] + "\n" + value["skillInstructions"])
