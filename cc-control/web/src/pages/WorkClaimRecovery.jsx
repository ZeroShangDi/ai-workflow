import { useCallback, useEffect, useMemo, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createApiClient } from '@/shared/lib/http.js';

export default function WorkClaimRecovery({ project }) {
  const client = useMemo(() => createApiClient({ project }), [project]);
  const [claims, setClaims] = useState([]);
  const [error, setError] = useState('');
  const [selectedClaim, setSelectedClaim] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!project) return;
    const result = await client.get(API.workClaims);
    if (result.ok) setClaims((result.data || []).filter(claim => claim.status === 'active'));
  }, [client, project]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 10000); return () => clearInterval(timer); }, [refresh]);
  async function recover() {
    if (!selectedClaim || busy) return;
    setBusy(true);
    try {
      const result = await client.post(API.recoverWorkClaim(selectedClaim.id), { actor: 'human' });
      if (!result.ok) throw new Error(result.error || '恢复失败');
      setError(''); setSelectedClaim(null); await refresh();
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }
  if (!claims.length && !error && !selectedClaim) return null;
  return <aside className="work-claims">
    {claims.map(claim => <div key={claim.id}><strong>工作区处理中</strong><span>{claim.branchName || claim.itemId}</span><small>{claim.owner === 'idle' ? '闲时任务' : '手动任务'}</small><button onClick={() => setSelectedClaim(claim)}>任务异常时恢复名额</button></div>)}
    {error && <p className="work-error" role="alert">{error}</p>}
    {selectedClaim && <div className="work-modal-backdrop"><section className="work-review work-small-dialog" role="dialog" aria-modal="true" aria-label="恢复工作区名额">
      <header><h2>恢复工作区名额</h2><button type="button" disabled={busy} onClick={() => setSelectedClaim(null)} aria-label="关闭">×</button></header>
      <p>请确认原任务已停止。恢复后工作分支和文件仍会保留。</p>
      <p className="work-dialog-subject">{selectedClaim.branchName || selectedClaim.itemId}</p>
      <div className="work-dialog-actions"><button type="button" disabled={busy} onClick={() => setSelectedClaim(null)}>取消</button><button type="button" className="work-button-primary" disabled={busy} onClick={recover}>{busy ? '处理中…' : '确认恢复'}</button></div>
    </section></div>}
  </aside>;
}
