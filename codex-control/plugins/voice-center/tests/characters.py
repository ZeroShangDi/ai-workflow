"""Self-contained character catalog tests; no audio/model/provider dependencies."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from voice_center_backend.characters import CharacterSettings

BUILTINS = Path(__file__).resolve().parents[1] / 'backend/voice_center_backend/characters/resources'


class CharacterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='voice-characters-')
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.selection = self.directory / 'state/selection.json'
        self.store = CharacterSettings(selection_file=self.selection)

    def test_builtin_catalog_and_assets_work_without_installing_the_old_plugin(self):
        result = self.store.list()
        self.assertEqual(result['defaultId'], 'whale-3')
        self.assertEqual(result['selectedId'], 'whale-3')
        self.assertEqual([v['id'] for v in result['characters']], ['elf-3', 'whale-3'])
        for key in ['elf-3', 'whale-3']:
            value = self.store.setting(key)
            self.assertTrue(value['persona'].strip())
            self.assertTrue(value['skillInstructions'].strip())
            self.assertTrue(value['voice']['referenceText'].strip())
            audio = self.store.resolve_asset(key, value['voice']['referenceAudio'])
            self.assertTrue(audio.is_relative_to(BUILTINS))
            self.assertEqual(audio.read_bytes()[:4], b'RIFF')
        image = self.store.setting('elf-3')['images']['multiView']
        self.assertTrue(self.store.resolve_asset('elf-3', image).is_file())
        self.assertEqual(self.store.setting('whale-3')['images']['multiView'], '')
        self.assertFalse(self.selection.exists())
        # Action metadata does not invent video resources absent from the bundle.
        with self.assertRaises(FileNotFoundError): self.store.resolve_asset('elf-3', 'idle.mp4')

    def test_selection_is_private_persistent_and_independent_from_old_state(self):
        self.store.select('whale-3')
        self.assertEqual(CharacterSettings(selection_file=self.selection).selected_id(), 'whale-3')
        self.assertEqual(self.selection.stat().st_mode & 0o777, 0o600)
        before = self.selection.read_bytes()
        with self.assertRaises(ValueError): self.store.select('unknown-3')
        self.assertEqual(self.selection.read_bytes(), before)
        self.assertIsNone(self.store.setting('unknown-3'))

    def test_returned_metadata_does_not_mutate_the_catalog(self):
        value = self.store.list()
        value['setting']['voice']['profile'] = 'changed'
        value['characters'][0]['card']['title'] = 'changed'
        value['setting']['actionGroups'].clear()
        fresh = self.store.setting('elf-3')
        self.assertEqual(fresh['voice']['profile'], 'elf-3')
        self.assertNotEqual(fresh['card']['title'], 'changed')
        self.assertTrue(fresh['actionGroups'])

    def test_corrupt_or_stale_state_falls_back_without_rewriting_it(self):
        self.selection.parent.mkdir()
        for raw in ['invalid json', '[]', 'null', '{"id":[]}', '{"id":"missing-3"}']:
            self.selection.write_text(raw)
            self.assertEqual(self.store.selected_id(), 'whale-3')
            self.assertEqual(self.selection.read_text(), raw)
        self.assertEqual(CharacterSettings(default_id='whale-3', selection_file=self.selection).selected_id(), 'whale-3')

    def test_failed_atomic_write_keeps_the_previous_selection(self):
        self.store.select('elf-3')
        with patch('voice_center_backend.characters.settings.os.replace', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError): self.store.select('whale-3')
        self.assertEqual(self.store.selected_id(), 'elf-3')
        self.assertEqual(list(self.selection.parent.glob('*.tmp')), [])

    def test_context_is_provider_independent_and_keeps_the_style_boundary(self):
        text = self.store.context()
        self.assertIn('不得覆盖权限、事实准确性与任务确认要求', text)
        self.assertIn(self.store.selected()['persona'], text)
        self.assertIn(self.store.selected()['skillInstructions'], text)
        self.store.select('whale-3')
        self.assertEqual(self.store.list('elf-3')['selectedId'], 'whale-3')
        self.assertEqual(self.store.list('elf-3')['setting']['id'], 'elf-3')
        with self.assertRaises(ValueError): self.store.context('unknown-3')

    def test_asset_paths_and_character_ids_cannot_escape_the_bundle(self):
        with self.assertRaises(ValueError): self.store.setting('../elf-3')
        with self.assertRaises(ValueError): self.store.resolve_asset('elf-3', '/etc/passwd')
        root = self.directory / 'resources'
        shutil.copytree(BUILTINS / 'elf-3', root / 'elf-3')
        outside = self.directory / 'outside.txt'
        outside.write_text('not character data')
        (root / 'elf-3/leak.txt').symlink_to(outside)
        store = CharacterSettings(root=root, selection_file=self.selection)
        with self.assertRaises(ValueError): store.resolve_asset('elf-3', 'leak.txt')
        with self.assertRaises(ValueError): store.resolve_asset('elf-3', '../../outside.txt')
        (root / 'elf-3/persona.md').unlink()
        (root / 'elf-3/persona.md').symlink_to(outside)
        with self.assertRaises(ValueError): CharacterSettings(root=root, selection_file=self.selection)

    def test_default_data_directory_and_read_only_loading(self):
        with patch.dict(os.environ, {'VOICE_CENTER_DATA_DIR': str(self.directory / 'voice-data'),
                                    'VOICE_CENTER_CHARACTER_DEFAULT_ID': 'whale-3'}):
            store = CharacterSettings()
            self.assertEqual(store.selected_id(), 'whale-3')
            self.assertEqual(store.selection_file, self.directory / 'voice-data/character-selection.json')
            self.assertFalse(store.selection_file.parent.exists())


if __name__ == '__main__': unittest.main()
