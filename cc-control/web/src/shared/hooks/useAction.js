import { useRef, useState } from 'react';
export function useAction(client, refresh, successMessage = () => '操作已提交') {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const inFlight = useRef(false);
  async function action(path, body) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await client.post(path, body);
      if (result?.ok === false) throw new Error(result.error || '操作失败');
      setMessage(successMessage(result));
      refresh();
      return result;
    } catch (e) {
      setMessage(e.message);
      refresh();
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    message,
    action,
  };
}
