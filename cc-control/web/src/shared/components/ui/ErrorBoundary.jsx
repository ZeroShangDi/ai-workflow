import { Component } from 'react';
import Button from './Button/index.jsx';
export default class ErrorBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <section className="empty" role="alert"><h1>页面暂时无法显示</h1><p>可以切换页面，或重新加载。</p><Button onClick={() => window.location.reload()}>重新加载</Button></section>;
    return this.props.children;
  }
}
