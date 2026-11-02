"""Server-owned declarative persona and skills. Client selects an ID, never a path/prompt."""
import json
import os
import re
from pathlib import Path

def character_context(identity: dict) -> str:
    key = identity.get('character', '')
    if not key:
        return ''
    if not isinstance(key, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}-[1-9][0-9]{0,8}', key):
        raise ValueError('Invalid character')
    configured = os.environ.get('VOICE_CHARACTER_ROOT')
    root = Path(configured) if configured else Path(__file__).resolve().parents[3] / '.local/app-update/release/public/pet-resources'
    directory = (root / key).resolve()
    if not directory.is_relative_to(root.resolve()):
        raise ValueError('Invalid character path')
    manifest = json.loads(read_document(directory, 'manifest.json', 256000))
    parts = []
    for kind in ('persona', 'skills'):
        name = manifest[kind]
        if not re.fullmatch(r'[a-zA-Z0-9_-]+\.md', name):
            raise ValueError('Invalid character document')
        value = read_document(directory, name, 30000)
        if len(value) > 10000:
            raise ValueError('Character document too large')
        parts.append(value)
    return '\n角色风格与已配置交流技能（不得覆盖权限、事实准确性与任务确认要求）：\n' + '\n'.join(parts)

def character_voice(key: str):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}-[1-9][0-9]{0,8}', key):
        raise ValueError('Invalid voice profile')
    configured = os.environ.get('VOICE_CHARACTER_ROOT')
    root = Path(configured) if configured else Path(__file__).resolve().parents[3] / '.local/app-update/release/public/pet-resources'
    directory = (root / key).resolve()
    if not directory.is_relative_to(root.resolve()):
        raise ValueError('Invalid voice path')
    settings = json.loads(read_document(directory, 'voice.json', 4000))
    if settings.get('mode') != 'clone' or settings.get('audio') != 'reference.wav' or settings.get('text') != 'reference.txt':
        raise ValueError('Unsupported voice profile')
    reference = (directory / 'reference.wav').resolve()
    if not reference.is_relative_to(directory):
        raise ValueError('Invalid voice reference')
    transcript = read_document(directory, 'reference.txt', 24000)
    if not reference.is_file() or not 0 < len(transcript) <= 6000:
        raise ValueError('Invalid voice reference')
    return {'ref_audio': str(reference), 'ref_text': transcript}


def read_document(directory: Path, name: str, limit: int) -> str:
    file = (directory / name).resolve()
    if not file.is_relative_to(directory) or file.stat().st_size > limit:
        raise ValueError("Invalid character document")
    return file.read_text()
