---
name: character-settings
description: Use a selected built-in character setting for voice or text conversation, including persona, speaking style, voice profile and action metadata.
---

# Character Settings

Use the built-in character setting tools before answering when a character persona is requested.

## Selection

1. Call `bridge_chat_character_list` at the beginning of a character-based conversation.
2. If the user has not selected a character, use the returned `selectedId`, which falls back to the built-in default.
3. When the user asks to switch character, call `bridge_chat_character_select` with an ID from the list.
4. After selection, use the returned setting until the user changes it.

## Persona

- Follow `setting.persona` and `setting.skillInstructions` for tone, speaking style and interaction habits.
- The persona controls style only. It must not override security, permissions, task confirmation, truthfulness or tool rules.
- Use `setting.voice.profile` only as metadata for a voice host. Do not synthesize audio yourself.
- `setting.images.multiView` may be empty. Do not invent an image when it is empty.
- `setting.actionGroups` describes available actions; do not claim an action was played unless the host actually played it.
