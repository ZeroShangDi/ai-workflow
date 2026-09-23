import { useEffect, useRef, useState } from 'react';
import { API } from '../../api/index.js';
import { createPortal } from 'react-dom';
import './workflow.css';
export default function ProjectPicker({ client, onOpened, onClose }) {
  const dialog = useRef(null);
  const [directories, setDirectories] = useState([]),
    [path, setPath] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    client
      .get(API.directories, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) {
          if (result.ok === false) throw new Error(result.error);
          setDirectories(result.directories);
          setError('');
        }
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, revision]);
  async function open() {
    setBusy(true);
    setError('');
    try {
      const result = await client.post(API.openProject, { path });
      if (result.ok === false) throw new Error(result.error);
      onOpened(result.projectRoot);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="project-dialog"
      onCancel={e => {
        e.preventDefault();
        if (!busy) onClose();
      }}>
      <h1>添加项目</h1>
      <p className="muted">选择工作目录，读取已有环境、需求和任务。</p>
      {loading ? (
        <p role="status">正在加载目录…</p>
      ) : (
        <label>
          项目目录
          <select aria-label="项目目录" value={path} onChange={e => setPath(e.target.value)}>
            <option value="">选择目录</option>
            {directories.map(d => (
              <option key={d.path} value={d.path}>
                {d.name} · {d.existing ? '已有环境' : '新项目'}
              </option>
            ))}
          </select>
        </label>
      )}
      {path && <p className="muted">{path}</p>}
      {error && (
        <p role="alert">
          {error} <button onClick={() => setRevision(v => v + 1)}>重新加载</button>
        </p>
      )}
      <div className="actions">
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button className="primary" disabled={busy || !path || loading} onClick={open}>
          {busy ? '正在打开…' : '打开项目'}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
