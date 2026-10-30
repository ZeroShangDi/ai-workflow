import { useEffect, useRef, useState } from 'react';
import { API } from '@/shared/api/index.js';
import { createPortal } from 'react-dom';
import './workflow.css';

export default function ProjectPicker({ client, onOpened, onClose }) {
  const dialog = useRef(null);
  const [options, setOptions] = useState([]);
  const [adapters, setAdapters] = useState([]);
  const [selectedOptions, setSelectedOptions] = useState({});
  const [project, setProject] = useState(null);
  const [checks, setChecks] = useState([]);
  const [adapter, setAdapter] = useState('cc');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!dialog.current.open) dialog.current.showModal();
    client.get(API.initOptions).then(response => {
      if (response.ok === false) throw new Error(response.error || '无法读取初始化选项');
      setOptions(response.options || []);
      setAdapters(response.adapters || []);
    }).catch(reason => setError(reason.message || '无法读取初始化选项'));
  }, [client]);

  async function chooseDirectory() {
    setError('');
    setBusy('select');
    try {
      const selection = await client.post(API.selectProjectFolder, {}, { timeoutMs: 130_000 });
      if (selection.ok === false) throw new Error(selection.error || '无法打开系统目录选择器');
      if (selection.cancelled || !selection.path) return;
      setBusy('inspect');
      const inspected = await client.post(API.inspectProject, { path: selection.path });
      if (inspected.ok === false) throw new Error(inspected.error || '无法检查项目');
      setProject(inspected.project);
      setChecks(inspected.checks || []);
      setAdapter(inspected.project.adapter || 'cc');
    } catch (reason) {
      setError(reason.message || '无法检查项目');
    } finally {
      setBusy('');
    }
  }

  async function initialize() {
    if (!project || busy) return;
    setBusy('initialize');
    setError('');
    try {
      const result = await client.post(API.initializeProject, {
        path: project.path, adapter,
        options: Object.fromEntries(options.map(option => [option.key, selectedOptions[option.key] === true])),
      }, { timeoutMs: 130_000 });
      if (result.ok === false) {
        setChecks(result.checks || checks);
        throw new Error(result.error || '项目初始化失败');
      }
      setProject(result.project);
      setChecks(result.checks || checks);
    } catch (reason) {
      setError(reason.message || '项目初始化失败');
    } finally {
      setBusy('');
    }
  }

  async function addProject() {
    if (!project?.initialized || busy) return;
    setBusy('add');
    setError('');
    try {
      const result = await client.post(API.addProject, { path: project.path });
      if (result.ok === false) throw new Error(result.error || '添加项目失败');
      onOpened(result.projectRoot);
    } catch (reason) {
      setError(reason.message || '添加项目失败');
      setBusy('');
    }
  }

  async function changeAdapter(value) {
    setAdapter(value);
    if (!project) return;
    try {
      const inspected = await client.post(API.inspectProject, { path: project.path, adapter: value });
      if (inspected.ok === false) throw new Error(inspected.error || '无法检查运行环境');
      setChecks(inspected.checks || []);
      setError('');
    } catch (reason) { setError(reason.message || '无法检查运行环境'); }
  }

  const status = busy === 'inspect' ? '正在检查…'
    : busy === 'initialize' ? '初始化中…'
      : project?.status || '请选择项目目录';
  const canInitialize = !!project && !project.initialized && !checks.some(check => !check.ok) && !busy;
  const canAdd = !!project?.initialized && !busy;

  return createPortal(
    <dialog ref={dialog} className="project-dialog project-picker-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="project-dialog-title">
        <span className="project-dialog-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2H20A1.5 1.5 0 0 1 21.5 10v7A1.5 1.5 0 0 1 20 18.5H4A1.5 1.5 0 0 1 2.5 17V8A1.5 1.5 0 0 1 4 6.5Z" /></svg></span>
        <div><h1>添加项目</h1></div>
      </div>
      <button type="button" className="project-directory-button" disabled={!!busy} onClick={chooseDirectory}>
        <span>{project?.name || '选择电脑上的项目目录'}</span>
        <small>{project?.path || '选择目录…'}</small>
        {project && <strong className={project.initialized ? 'is-ready' : 'is-pending'}>{project.registered ? '已添加' : project.initialized ? '已初始化' : '未初始化'}</strong>}
      </button>
      {project && <>
        <label className="project-picker-select-label">运行环境
          <select value={adapter} onChange={event => changeAdapter(event.target.value)} disabled={project.initialized || !!busy}>
            {adapters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {!project.initialized && options.length > 0 && <div className="project-init-options">
          {options.map(option => <label key={option.key} title={option.description}>
            <input type="checkbox" checked={selectedOptions[option.key] === true} onChange={event => setSelectedOptions(old => ({ ...old, [option.key]: event.target.checked }))} />
            <span>{option.label}</span>
            <span className="project-option-help" title={option.description} aria-label={option.description}>?</span>
          </label>)}
        </div>}
        {!!checks.length && checks.some(check => !check.ok) && <ul className="project-init-checks" role="alert">
          {checks.filter(check => !check.ok).map(check => <li key={check.name} title={check.hint}>缺少 {check.name}</li>)}
        </ul>}
      </>}
      <p role={error ? 'alert' : 'status'} className={error ? 'project-picker-error' : 'project-picker-status'}>{error || status}</p>
      <div className="actions">
        <button type="button" disabled={!!busy} onClick={onClose}>取消</button>
        <button type="button" disabled={!canInitialize} onClick={initialize}>{busy === 'initialize' ? '初始化中…' : '初始化'}</button>
        <button type="button" className="primary" disabled={!canAdd} onClick={addProject}>{busy === 'add' ? '打开中…' : project?.registered ? '打开项目' : '添加项目'}</button>
      </div>
    </dialog>,
    document.body,
  );
}
