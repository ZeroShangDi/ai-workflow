"""Read the same account's ordinary conversations through the existing chat store."""
import os
from urllib.parse import urlencode
import httpx


def validate_conversation_id(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or value.startswith('0') or len(value) > 19:
        raise ValueError('会话编号无效')
    return value


class ConversationHistory:
    async def chat_api(self, path, permission_path):
        if len(os.environ.get('VOICE_CENTER_AI_INTERNAL_TOKEN', os.environ.get('AI_INTERNAL_TOKEN', ''))) < 32:
            raise ValueError('聊天历史服务尚未配置')
        # Recheck the current mobile login, device and conversation ownership.
        try:
            grant = await self.host.request('GET', permission_path, None, None)
        except (RuntimeError, TimeoutError) as error:
            raise ValueError('聊天历史授权未确认，请更新 App 并核对会话权限') from error
        if not isinstance(grant, dict) or grant.get('authorized') is not True:
            raise ValueError('聊天历史授权未确认，请更新 App 并核对会话权限')
        headers = {'Authorization': 'Bearer ' + os.environ.get('VOICE_CENTER_AI_INTERNAL_TOKEN', os.environ.get('AI_INTERNAL_TOKEN', '')),
            **{f'X-AI-{key.title()}': self.identity[key] for key in ('tenant', 'user', 'device')}}
        async with httpx.AsyncClient(timeout=15, trust_env=False, follow_redirects=False) as client:
            response = await client.get(os.environ.get('VOICE_CENTER_AI_SERVICE_URL', os.environ.get('AI_SERVICE_URL', 'http://127.0.0.1:48081')).rstrip('/')
                + '/internal/v1/ai' + path, headers=headers)
            response.raise_for_status()
            return response.json()['data']

    async def list_conversations(self, cursor=None, limit=20):
        if type(limit) is not int or not 1 <= limit <= 30 or cursor is not None and (not isinstance(cursor, str) or len(cursor) > 200):
            raise ValueError('分页参数无效')
        query = {'limit': limit}
        if cursor: query['cursor'] = cursor
        result = await self.chat_api('/conversations?' + urlencode(query), '/api/v1/mobile/ai/conversations')
        return {'items': [{k: item.get(k) for k in ('id', 'title', 'created_at', 'updated_at')}
            for item in result['items']], 'next_cursor': result.get('next_cursor')}

    async def read_conversation(self, conversation_id, cursor=None, limit=20):
        cid = validate_conversation_id(conversation_id)
        if type(limit) is not int or not 1 <= limit <= 30:
            raise ValueError('分页数量无效')
        query = {'limit': limit}
        if cursor is not None: query['cursor'] = validate_conversation_id(cursor)
        return await self.chat_api('/conversations/' + cid + '/messages?' + urlencode(query),
            '/api/v1/mobile/ai/conversations/' + cid + '/messages?limit=1')
